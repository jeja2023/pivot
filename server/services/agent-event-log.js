const crypto = require('crypto');
const { query, queryOne, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { redactTraceValue } = require('./agent-traces');
const { buildAgentAuditFields } = require('./agent-step-context');
const { getRequestId } = require('./request-context');

function payloadHash(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex');
}

function publicEvent(row) {
    if (!row) return row;
    const id = Number(row.id);
    return { ...row, id: Number.isSafeInteger(id) ? id : String(row.id) };
}

async function lockEventUsers(trx, userIds) {
    if (!userIds.length) return;
    // 每用户持有事务锁直到提交，使该用户事件 ID 的分配顺序与提交顺序一致。
    // 批量事件可能涉及多个用户，必须按固定顺序取锁以避免死锁。
    await trx.query(`
        SELECT pg_advisory_xact_lock(hashtext('pivot:agent-event-user'), hashtext(current_schema() || ':' || ordered.id::text))
        FROM (SELECT id FROM unnest(?::bigint[]) AS item(id) ORDER BY id) ordered
    `, [userIds]);
}

function prepareAgentEvent({ runId, userId = null, type, payload = {}, turnId = '', stepIndex = 0, providerVisible = false, eventKey = '', stepContext = null, entrypoint = '' } = {}) {
    if (!runId || !type) return null;
    const auditContext = buildAgentAuditFields({
        ...(stepContext && typeof stepContext === 'object' ? stepContext : {}),
        runId,
        turnId,
        stepIndex,
        contextHash: stepContext?.contextHash || payload?.contextHash || '',
        worldStateHash: stepContext?.worldStateHash || payload?.worldStateHash || '',
        worldStateMode: stepContext?.worldStateInjection?.mode || payload?.worldStateMode || '',
        previousWorldStateHash: stepContext?.previousWorldStateHash || payload?.previousWorldStateHash || '',
        worldStateWindow: stepContext?.worldStateWindow || payload?.contextWindow || {}
    }, { entrypoint: entrypoint || stepContext?.entrypoint || payload?.entrypoint || 'agent', purpose: type });
    const requestId = getRequestId();
    const safePayload = redactTraceValue({ ...payload, ...auditContext, ...(requestId ? { requestId } : {}) });
    // 仅恢复压缩审计中明确的非敏感整数计数，令牌、密钥和任意字符串仍由通用脱敏规则保护。
    if (type === 'context.compacted' && safePayload?.compaction && payload?.compaction) {
        for (const key of ['targetTokens', 'inputTokensBefore', 'inputTokensAfter']) {
            const value = payload.compaction[key];
            if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 999999999999) {
                safePayload.compaction[key] = value;
            }
        }
    }
    return {
        runId, userId, safePayload, hash: payloadHash(safePayload), now: getBeijingTimestamp(),
        safeEventKey: String(eventKey || '').slice(0, 255), safeEventType: String(type).slice(0, 80),
        turnId: String(turnId || '').slice(0, 160), stepIndex: Math.max(Number(stepIndex) || 0, 0),
        providerVisible: Boolean(providerVisible)
    };
}

async function recordAgentEvent(input = {}, { transactionFn = transaction } = {}) {
    const prepared = prepareAgentEvent(input);
    if (!prepared) return null;
    const { runId, userId, safePayload, hash, now, safeEventKey, safeEventType, turnId, stepIndex, providerVisible } = prepared;
    return transactionFn(async trx => {
        // Lock the run row so sequence allocation and idempotency checks are atomic.
        const run = await trx.queryOne('SELECT user_id, event_seq FROM agent_runs WHERE id = ? FOR UPDATE', [runId]);
        if (!run) return null;
        const effectiveUserId = userId ?? run.user_id;
        if (!effectiveUserId || !(await trx.queryOne('SELECT id FROM users WHERE id = ?', [effectiveUserId]))) return null;
        await lockEventUsers(trx, [effectiveUserId]);
        if (safeEventKey) {
            const existing = await trx.queryOne(`
                SELECT id::text AS id, run_id, user_id, event_seq, event_type, created_at, outbox_retired_at
                FROM agent_events
                WHERE run_id = ? AND event_type = ? AND event_key = ?
                ORDER BY event_seq ASC
                LIMIT 1 FOR UPDATE
            `, [runId, safeEventType, safeEventKey]);
            if (existing) {
                if (!existing.outbox_retired_at) await trx.execute(`
                    INSERT INTO agent_event_outbox (
                        event_id, run_id, user_id, event_seq, event_type, payload,
                        status, available_at, created_at, updated_at
                    )
                    SELECT id, run_id, user_id, event_seq, event_type, payload,
                           'pending', ?, ?, ?
                    FROM agent_events
                    WHERE id = ?
                    ON CONFLICT (event_id) DO NOTHING
                `, [now, now, now, existing.id]);
                const { outbox_retired_at: _retiredAt, ...existingEvent } = existing;
                return publicEvent(existingEvent);
            }
        }
        const nextSeq = (Number(run.event_seq) || 0) + 1;
        await trx.execute('UPDATE agent_runs SET event_seq = ?, updated_at = ? WHERE id = ?', [nextSeq, now, runId]);
        const result = await trx.queryOne(`
            INSERT INTO agent_events (
                run_id, user_id, event_seq, event_key, event_type, turn_id, step_index,
                payload, payload_hash, provider_visible, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, run_id, user_id, event_seq, event_type, created_at
        `, [
            runId,
            effectiveUserId,
            nextSeq,
            safeEventKey,
            safeEventType,
            turnId,
            stepIndex,
            JSON.stringify(safePayload ?? {}),
            hash,
            Boolean(providerVisible),
            now
        ]);
        if (result?.id) {
            await trx.execute(`
                INSERT INTO agent_event_outbox (
                    event_id, run_id, user_id, event_seq, event_type, payload,
                    status, available_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
                ON CONFLICT (event_id) DO NOTHING
            `, [
                result.id,
                runId,
                effectiveUserId,
                nextSeq,
                safeEventType,
                JSON.stringify(safePayload ?? {}),
                now,
                now,
                now
            ]);
        }
        return publicEvent(result);
    });
}

// 有界事件批次保留各自的幂等键和序号；任何事件失败时整体回滚。
async function recordAgentEventBatch(events = [], { transactionFn = transaction } = {}) {
    if (!Array.isArray(events) || events.length === 0) return [];
    if (events.length > 256) throw new Error('Agent 事件批次超过上限。');
    const runId = events[0]?.runId;
    if (!runId || events.some(event => event?.runId !== runId)) throw new Error('Agent 事件批次必须属于同一运行。');
    const prepared = events.map(prepareAgentEvent);
    return transactionFn(async trx => {
        const run = await trx.queryOne('SELECT user_id, event_seq FROM agent_runs WHERE id = ? FOR UPDATE', [runId]);
        if (!run) return events.map(() => null);
        const userIds = [...new Set(prepared.filter(Boolean).map(event => String(event.userId ?? run.user_id)).filter(Boolean))];
        const users = userIds.length ? await trx.query('SELECT id FROM users WHERE id = ANY(?::bigint[])', [userIds]) : [];
        const validUsers = new Set(users.map(user => String(user.id)));
        await lockEventUsers(trx, [...validUsers]);
        const keys = prepared.filter(event => event?.safeEventKey).map(event => ({ event_type: event.safeEventType, event_key: event.safeEventKey }));
        const existingRows = keys.length ? await trx.query(`
            SELECT e.id::text AS id, e.run_id, e.user_id, e.event_seq, e.event_type, e.event_key, e.created_at, e.outbox_retired_at
            FROM agent_events e JOIN (
                SELECT DISTINCT event_type, event_key FROM jsonb_to_recordset(?::jsonb) AS k(event_type text, event_key text)
            ) k ON k.event_type = e.event_type AND k.event_key = e.event_key
            WHERE e.run_id = ? ORDER BY e.event_seq ASC FOR UPDATE OF e
        `, [JSON.stringify(keys), runId]) : [];
        const identities = new Map();
        const identity = event => JSON.stringify([event.safeEventType, event.safeEventKey]);
        for (const row of existingRows) {
            const key = JSON.stringify([row.event_type, row.event_key]);
            if (!identities.has(key)) identities.set(key, { existing: row });
        }
        let sequence = Number(run.event_seq) || 0;
        const pending = [];
        const plans = prepared.map(event => {
            const userId = event && (event.userId ?? run.user_id);
            if (!event || !userId || !validUsers.has(String(userId))) return null;
            const key = event.safeEventKey ? identity(event) : '';
            if (key && identities.has(key)) return identities.get(key);
            sequence += 1;
            const plan = { sequence };
            if (key) identities.set(key, plan);
            pending.push({
                user_id: userId, event_seq: sequence, event_key: event.safeEventKey, event_type: event.safeEventType,
                turn_id: event.turnId, step_index: event.stepIndex, payload: event.safePayload, payload_hash: event.hash,
                provider_visible: event.providerVisible, created_at: event.now
            });
            return plan;
        });
        let inserted = [];
        if (pending.length) {
            await trx.execute('UPDATE agent_runs SET event_seq = ?, updated_at = ? WHERE id = ?', [sequence, getBeijingTimestamp(), runId]);
            inserted = await trx.query(`
                INSERT INTO agent_events (run_id, user_id, event_seq, event_key, event_type, turn_id, step_index, payload, payload_hash, provider_visible, created_at)
                SELECT ?, item.user_id, item.event_seq, item.event_key, item.event_type, item.turn_id, item.step_index,
                       item.payload, item.payload_hash, item.provider_visible, item.created_at::timestamptz
                FROM jsonb_to_recordset(?::jsonb) AS item(user_id bigint, event_seq bigint, event_key text, event_type text,
                    turn_id text, step_index integer, payload jsonb, payload_hash text, provider_visible boolean, created_at text)
                ORDER BY item.event_seq
                RETURNING id::text AS id, run_id, user_id, event_seq, event_type, created_at
            `, [runId, JSON.stringify(pending)]);
        }
        const insertedBySequence = new Map(inserted.map(row => [Number(row.event_seq), row]));
        const results = plans.map(plan => {
            if (!plan) return null;
            if (!plan.existing) return insertedBySequence.get(plan.sequence) || null;
            const { event_key: _key, outbox_retired_at: _retired, ...existing } = plan.existing;
            return existing;
        });
        const ids = [...new Set(results.filter(Boolean).map(row => String(row.id)))];
        if (ids.length) {
            const now = getBeijingTimestamp();
            await trx.execute(`
                INSERT INTO agent_event_outbox (event_id, run_id, user_id, event_seq, event_type, payload, status, available_at, created_at, updated_at)
                SELECT id, run_id, user_id, event_seq, event_type, payload, 'pending', ?, ?, ?
                FROM agent_events WHERE id = ANY(?::bigint[]) AND outbox_retired_at IS NULL
                ON CONFLICT (event_id) DO NOTHING
            `, [now, now, now, ids]);
        }
        return results.map(publicEvent);
    });
}

async function listAgentEventsForUser(runId, user, { after = 0, limit = 200, types = [] } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const afterSeq = Math.max(Number(after) || 0, 0);
    const allowedTypes = (Array.isArray(types) ? types : String(types || '').split(','))
        .map(value => String(value || '').trim()).filter(Boolean).slice(0, 30);
    const typeClause = allowedTypes.length ? ` AND event_type IN (${allowedTypes.map(() => '?').join(', ')})` : '';
    const params = [runId, user.id, afterSeq, ...allowedTypes, safeLimit];
    const rows = await query(`
        SELECT id, run_id, user_id, event_seq, event_key, event_type, turn_id, step_index,
               payload, payload_hash, provider_visible, created_at
        FROM agent_events
        WHERE run_id = ? AND user_id = ? AND event_seq > ?${typeClause}
        ORDER BY event_seq ASC
        LIMIT ?
    `, params);
    return rows.map(row => ({
        ...row,
        payload: typeof row.payload === 'string' ? (() => { try { return JSON.parse(row.payload); } catch (_) { return {}; } })() : (row.payload || {})
    }));
}

async function getAgentEventCursorForUser(runId, user) {
    const row = await queryOne(`
        SELECT COALESCE(MAX(event_seq), 0) AS event_seq, COUNT(*) AS event_count
        FROM agent_events WHERE run_id = ? AND user_id = ?
    `, [runId, user.id]);
    return { eventSeq: Number(row?.event_seq || 0), eventCount: Number(row?.event_count || 0) };
}

async function replayAgentEventsForUser(runId, user, { after = 0, limit = 200, types = [] } = {}) {
    const events = await listAgentEventsForUser(runId, user, { after, limit, types });
    const cursor = await getAgentEventCursorForUser(runId, user);
    const last = events.length ? Number(events[events.length - 1].event_seq || after || 0) : Math.max(Number(after) || 0, 0);
    return {
        events,
        cursor,
        nextAfter: last,
        hasMore: last < cursor.eventSeq
    };
}

module.exports = {
    getAgentEventCursorForUser,
    listAgentEventsForUser,
    payloadHash,
    replayAgentEventsForUser,
    recordAgentEvent,
    recordAgentEventBatch
};
