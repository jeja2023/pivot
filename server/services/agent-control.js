const crypto = require('crypto');
const { query, queryOne, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { redactTraceValue } = require('./agent-traces');
const { recordAgentEvent } = require('./agent-event-log');

const MESSAGE_TYPES = new Set(['steer', 'request', 'reply', 'system']);
const MESSAGE_STATUSES = new Set(['pending', 'delivered', 'acknowledged', 'expired']);
const MAX_PAYLOAD_CHARS = 120000;

function payloadHash(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex');
}

function normalizeMessageType(value) {
    const type = String(value || 'steer').trim().toLowerCase();
    return MESSAGE_TYPES.has(type) ? type : 'steer';
}

function serializePayload(payload) {
    const safe = redactTraceValue(payload ?? {});
    let text = JSON.stringify(safe);
    if (text.length <= MAX_PAYLOAD_CHARS) return { safe, text };
    const compact = {
        truncated: true,
        originalLength: text.length,
        text: text.slice(0, MAX_PAYLOAD_CHARS - 200)
    };
    return { safe: compact, text: JSON.stringify(compact) };
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
    return transaction(async trx => {
        await trx.execute(`
            UPDATE agent_control_messages
            SET status = 'expired'
            WHERE user_id = ? AND to_run_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
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
        for (const row of rows) {
            await trx.execute(`UPDATE agent_control_messages SET status = 'delivered', delivered_at = ? WHERE id = ?`, [now, row.id]);
        }
        return rows.map(row => parseMessage({ ...row, status: 'delivered', delivered_at: now }));
    });
}

async function acknowledgeAgentControlMessage(messageId, user, runId = '') {
    const userId = Number(user?.id || 0);
    if (!userId || !messageId) return null;
    const row = await queryOne(`
        UPDATE agent_control_messages
        SET status = 'acknowledged', acknowledged_at = ?
        WHERE message_id = ? AND user_id = ? AND to_run_id = ?
          AND status IN ('pending', 'delivered')
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
    assertRelatedRuns,
    claimAgentControlMessages,
    listAgentControlMessages,
    normalizeMessageType,
    sendAgentControlMessage
};
