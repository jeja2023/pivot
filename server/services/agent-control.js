const crypto = require('crypto');
const { query, queryOne, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { recordAgentEvent } = require('./agent-event-log');

const MESSAGE_TYPES = new Set(['steer', 'request', 'reply', 'system']);
const MESSAGE_STATUSES = new Set(['pending', 'claimed', 'delivered', 'acknowledged', 'expired']);
const MAX_PAYLOAD_CHARS = 120000;
const CONTROL_CLAIM_LEASE_MS = Math.max(30_000, Number.parseInt(process.env.AGENT_CONTROL_CLAIM_LEASE_MS || '60000', 10) || 60_000);
const SECRET_KEY_RE = /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)/i;

function payloadHash(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex');
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function redactControlPayload(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    if (depth >= 8 || seen.has(value)) return '[已省略嵌套对象]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 200).map(item => redactControlPayload(item, depth + 1, seen));
    return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, item]) => [
        key,
        SECRET_KEY_RE.test(key) ? '[已脱敏]' : redactControlPayload(item, depth + 1, seen)
    ]));
}

function normalizeMessageType(value) {
    const type = String(value || 'steer').trim().toLowerCase();
    return MESSAGE_TYPES.has(type) ? type : 'steer';
}

function serializePayload(payload) {
    const safe = redactControlPayload(payload ?? {});
    let text = JSON.stringify(safe);
    if (text.length <= MAX_PAYLOAD_CHARS) return { safe, text };
    const error = new Error(`控制指令超过 ${MAX_PAYLOAD_CHARS} 字符上限，未写入可能被截断的内容。`);
    error.code = 'AGENT_CONTROL_PAYLOAD_TOO_LARGE';
    error.status = 413;
    throw error;
}

function applyMessagesToTaskContract(value, messages = {}, goal = '') {
    const { normalizeTaskContract } = require('./agent-verification');
    const contract = normalizeTaskContract(value, goal);
    const existing = new Set(contract.constraints.map(item => String(item || '').trim()).filter(Boolean));
    let changed = 0;
    for (const message of Array.isArray(messages) ? messages : []) {
        const payload = message?.payload && typeof message.payload === 'object' ? message.payload : {};
        const instruction = String(payload.instruction || payload.message || payload.text || '').trim().slice(0, 4000);
        if (!instruction || existing.has(instruction)) continue;
        existing.add(instruction);
        contract.constraints.push(instruction);
        changed += 1;
    }
    contract.constraints = contract.constraints.slice(-32);
    if (changed) {
        contract.revision = Math.max(1, Number(contract.revision || 1)) + changed;
        contract.source = 'control_message';
    }
    return { contract, changed };
}

async function getControlRun(runId, userId) {
    if (!runId) return null;
    return queryOne(`
        SELECT id, user_id, parent_run_id, status, deleted_at
        FROM agent_runs
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `, [runId, userId]);
}

async function getLineage(runIds) {
    const ids = [...new Set(runIds.filter(Boolean).map(String))];
    if (!ids.length) return new Map();
    const rows = await query(`
        WITH RECURSIVE lineage(start_id, id, parent_run_id) AS (
            SELECT id, id, parent_run_id
            FROM agent_runs
            WHERE id IN (${ids.map(() => '?').join(', ')})
            UNION
            SELECT lineage.start_id, parent.id, parent.parent_run_id
            FROM lineage
            JOIN agent_runs parent ON parent.id = lineage.parent_run_id
        )
        SELECT start_id, id, parent_run_id FROM lineage
    `, ids);
    const result = new Map(ids.map(id => [id, new Set()]));
    rows.forEach(row => result.get(String(row.start_id))?.add(String(row.id)));
    return result;
}

async function assertRelatedRuns(fromRunId, toRunId, userId) {
    const target = await getControlRun(toRunId, userId);
    if (!target) throw Object.assign(new Error('目标 Agent Run 不存在或无权访问。'), { status: 404, code: 'AGENT_CONTROL_TARGET_NOT_FOUND' });
    if (!fromRunId) return target;
    const source = await getControlRun(fromRunId, userId);
    if (!source) throw Object.assign(new Error('来源 Agent Run 不存在或无权访问。'), { status: 404, code: 'AGENT_CONTROL_SOURCE_NOT_FOUND' });
    const lineages = await getLineage([fromRunId, toRunId]);
    const sourceLineage = lineages.get(String(fromRunId)) || new Set();
    const targetLineage = lineages.get(String(toRunId)) || new Set();
    const related = sourceLineage.has(String(toRunId))
        || targetLineage.has(String(fromRunId))
        || [...sourceLineage].some(id => targetLineage.has(id));
    if (!related) throw Object.assign(new Error('AgentControl 消息只能在同一父子运行树内投递。'), { status: 403, code: 'AGENT_CONTROL_SCOPE_DENIED' });
    return target;
}

function parseMessage(row) {
    let payload = row.payload;
    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (_) { payload = {}; }
    }
    return { ...row, payload: payload || {} };
}

async function sendAgentControlMessage({ user, fromRunId = '', toRunId, type = 'steer', payload = {}, expiresAt = null } = {}) {
    const userId = Number(user?.id || 0);
    if (!userId || !toRunId) throw Object.assign(new Error('AgentControl 消息缺少用户或目标运行。'), { status: 400, code: 'AGENT_CONTROL_INVALID' });
    await assertRelatedRuns(fromRunId, toRunId, userId);
    const serialized = serializePayload(payload);
    const messageId = `acm_${crypto.randomUUID()}`;
    const now = getBeijingTimestamp();
    const row = await queryOne(`
        INSERT INTO agent_control_messages (
            message_id, user_id, from_run_id, to_run_id, message_type, status,
            payload, payload_hash, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        RETURNING message_id, user_id, from_run_id, to_run_id, message_type, status,
                  payload, payload_hash, created_at, delivered_at, acknowledged_at, expires_at
    `, [
        messageId,
        userId,
        fromRunId || null,
        toRunId,
        normalizeMessageType(type),
        serialized.text,
        payloadHash(serialized.safe),
        now,
        expiresAt || null
    ]);
    try {
        await recordAgentEvent({
            runId: toRunId,
            userId,
            type: 'control.message_sent',
            payload: { messageId, fromRunId: fromRunId || '', messageType: normalizeMessageType(type), payloadHash: payloadHash(serialized.safe) },
            eventKey: `control:${messageId}`
        });
    } catch (_) {}
    return parseMessage(row);
}

async function listAgentControlMessages(runId, user, { limit = 100, after = 0, status = '' } = {}) {
    const userId = Number(user?.id || 0);
    const run = await getControlRun(runId, userId);
    if (!run) return null;
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const clauses = ['user_id = ?', '(from_run_id = ? OR to_run_id = ?)', 'id > ?'];
    const params = [userId, runId, runId, Math.max(Number(after) || 0, 0)];
    if (MESSAGE_STATUSES.has(String(status || '').trim())) {
        clauses.push('status = ?');
        params.push(String(status).trim());
    }
    params.push(safeLimit);
    const rows = await query(`
        SELECT id, message_id, user_id, from_run_id, to_run_id, message_type, status,
               payload, payload_hash, created_at, delivered_at, acknowledged_at, expires_at
        FROM agent_control_messages
        WHERE ${clauses.join(' AND ')}
        ORDER BY id ASC
        LIMIT ?
    `, params);
    return rows.map(parseMessage);
}

async function claimAgentControlMessages(runId, user, { limit = 20 } = {}) {
    const userId = Number(user?.id || 0);
    const run = await getControlRun(runId, userId);
    if (!run) return [];
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const now = getBeijingTimestamp();
    const claimExpiresAt = getBeijingTimestamp(new Date(Date.now() + CONTROL_CLAIM_LEASE_MS));
    return transaction(async trx => {
        await trx.execute(`
            UPDATE agent_control_messages
            SET status = 'expired', claim_token = NULL, claim_expires_at = NULL
            WHERE user_id = ? AND to_run_id = ? AND status IN ('pending', 'claimed')
              AND expires_at IS NOT NULL AND expires_at <= ?
        `, [userId, runId, now]);
        await trx.execute(`
            UPDATE agent_control_messages
            SET status = 'pending', claim_token = NULL, claim_expires_at = NULL
            WHERE user_id = ? AND to_run_id = ? AND status = 'claimed'
              AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?
        `, [userId, runId, now]);
        const rows = await trx.query(`
            SELECT id, message_id, user_id, from_run_id, to_run_id, message_type, status,
                   payload, payload_hash, created_at, delivered_at, acknowledged_at, expires_at
            FROM agent_control_messages
            WHERE user_id = ? AND to_run_id = ? AND status = 'pending'
              AND (expires_at IS NULL OR expires_at > ?)
            ORDER BY id ASC
            LIMIT ?
            FOR UPDATE SKIP LOCKED
        `, [userId, runId, now, safeLimit]);
        const claimed = [];
        for (const row of rows) {
            const claimToken = `acm_claim_${crypto.randomUUID()}`;
            await trx.execute(`
                UPDATE agent_control_messages
                SET status = 'claimed', delivered_at = COALESCE(delivered_at, ?), claim_token = ?, claim_expires_at = ?
                WHERE id = ? AND status = 'pending'
            `, [now, claimToken, claimExpiresAt, row.id]);
            claimed.push(parseMessage({ ...row, status: 'claimed', delivered_at: row.delivered_at || now, claim_token: claimToken, claim_expires_at: claimExpiresAt }));
        }
        return claimed;
    });
}

async function applyAgentControlMessages(runId, user, messages = []) {
    const userId = Number(user?.id || 0);
    const requested = (Array.isArray(messages) ? messages : []).map(message => ({
        messageId: String(message?.message_id || message?.messageId || '').trim(),
        claimToken: String(message?.claim_token || message?.claimToken || '').trim()
    })).filter(item => item.messageId && item.claimToken);
    if (!userId || !runId || !requested.length) return [];
    const now = getBeijingTimestamp();
    return transaction(async trx => {
        const run = await trx.queryOne(`
            SELECT metadata FROM agent_runs
            WHERE id = ? AND user_id = ? AND deleted_at IS NULL
            FOR UPDATE
        `, [runId, userId]);
        if (!run) return [];
        const applied = [];
        for (const item of requested) {
            const row = await trx.queryOne(`
                SELECT id, message_id, user_id, from_run_id, to_run_id, message_type, status,
                       payload, payload_hash, created_at, delivered_at, acknowledged_at, expires_at
                FROM agent_control_messages
                WHERE message_id = ? AND user_id = ? AND to_run_id = ?
                  AND status = 'claimed' AND claim_token = ?
                  AND (claim_expires_at IS NULL OR claim_expires_at > ?)
                FOR UPDATE
            `, [item.messageId, userId, runId, item.claimToken, now]);
            if (!row) continue;
            const changed = await trx.execute(`
                UPDATE agent_control_messages
                SET status = 'acknowledged', applied_at = ?, acknowledged_at = ?, claim_token = NULL, claim_expires_at = NULL
                WHERE id = ? AND status = 'claimed' AND claim_token = ?
            `, [now, now, row.id, item.claimToken]);
            if (changed > 0) applied.push(parseMessage({ ...row, status: 'acknowledged', applied_at: now, acknowledged_at: now }));
        }
        if (!applied.length) return [];
        const metadata = parseJson(run.metadata, {});
        const { applyControlMessagesToWorkingState } = require('./agent-working-state');
        const currentContract = metadata.taskContract || metadata.task_contract || {};
        const { contract: taskContract } = applyMessagesToTaskContract(currentContract, applied, currentContract.goal || '');
        const workingState = applyControlMessagesToWorkingState(metadata.workingState, applied, taskContract, taskContract.goal || '');
        const existing = Array.isArray(metadata.controlApplications?.messageIds)
            ? metadata.controlApplications.messageIds.map(String) : [];
        const messageIds = [...new Set([...existing, ...applied.map(message => message.message_id)])].slice(-100);
        await trx.execute(`
            UPDATE agent_runs
            SET metadata = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [JSON.stringify({
            ...metadata,
            controlApplications: {
                revision: Number(taskContract.revision || metadata.controlApplications?.revision || 0),
                messageIds,
                appliedAt: now
            },
            taskContract,
            workingState
        }), now, runId, userId]);
        return applied.map(message => ({ ...message, taskContract, workingState }));
    });
}

async function listAppliedAgentControlMessages(runId, user, { limit = 20 } = {}) {
    const userId = Number(user?.id || 0);
    const run = await getControlRun(runId, userId);
    if (!run) return null;
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const rows = await query(`
        SELECT id, message_id, user_id, from_run_id, to_run_id, message_type, status,
               payload, payload_hash, created_at, delivered_at, acknowledged_at, expires_at, applied_at
        FROM agent_control_messages
        WHERE user_id = ? AND to_run_id = ? AND status = 'acknowledged' AND applied_at IS NOT NULL
        ORDER BY applied_at ASC, id ASC
        LIMIT ?
    `, [userId, runId, safeLimit]);
    return rows.map(parseMessage);
}

async function acknowledgeAgentControlMessage(messageId, user, runId = '') {
    const userId = Number(user?.id || 0);
    if (!userId || !messageId) return null;
    const row = await queryOne(`
        UPDATE agent_control_messages
        SET status = 'acknowledged', acknowledged_at = ?
        WHERE message_id = ? AND user_id = ? AND to_run_id = ?
          AND status IN ('pending', 'claimed', 'delivered')
        RETURNING message_id, user_id, from_run_id, to_run_id, message_type, status,
                  payload, payload_hash, created_at, delivered_at, acknowledged_at, expires_at
    `, [getBeijingTimestamp(), messageId, userId, runId]);
    if (!row) return null;
    try { await recordAgentEvent({ runId, userId, type: 'control.message_acknowledged', payload: { messageId }, eventKey: `control:${messageId}:ack` }); } catch (_) {}
    return parseMessage(row);
}

module.exports = {
    MESSAGE_STATUSES,
    MESSAGE_TYPES,
    acknowledgeAgentControlMessage,
    applyAgentControlMessages,
    assertRelatedRuns,
    claimAgentControlMessages,
    listAppliedAgentControlMessages,
    listAgentControlMessages,
    normalizeMessageType,
    sendAgentControlMessage
};
