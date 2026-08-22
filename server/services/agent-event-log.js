const crypto = require('crypto');
const { query, queryOne, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { redactTraceValue } = require('./agent-traces');

function payloadHash(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex');
}

async function recordAgentEvent({ runId, userId = null, type, payload = {}, turnId = '', stepIndex = 0, providerVisible = false, eventKey = '' } = {}) {
    if (!runId || !type) return null;
    const safePayload = redactTraceValue(payload);
    const hash = payloadHash(safePayload);
    const now = getBeijingTimestamp();
    const safeEventKey = String(eventKey || '').slice(0, 255);
    const safeEventType = String(type).slice(0, 80);
    return transaction(async trx => {
        // Lock the run row so sequence allocation and idempotency checks are atomic.
        const run = await trx.queryOne('SELECT user_id, event_seq FROM agent_runs WHERE id = ? FOR UPDATE', [runId]);
        if (!run) return null;
        const effectiveUserId = userId ?? run.user_id;
        if (!effectiveUserId || !(await trx.queryOne('SELECT id FROM users WHERE id = ?', [effectiveUserId]))) return null;
        if (safeEventKey) {
            const existing = await trx.queryOne(`
                SELECT id, run_id, user_id, event_seq, event_type, created_at
                FROM agent_events
                WHERE run_id = ? AND event_type = ? AND event_key = ?
                ORDER BY event_seq ASC
                LIMIT 1
            `, [runId, safeEventType, safeEventKey]);
            if (existing) {
                await trx.execute(`
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
                return existing;
            }
        }
        const nextSeq = (Number(run.event_seq) || 0) + 1;
        await trx.execute('UPDATE agent_runs SET event_seq = ?, updated_at = ? WHERE id = ?', [nextSeq, now, runId]);
        const result = await trx.queryOne(`
            INSERT INTO agent_events (
                run_id, user_id, event_seq, event_key, event_type, turn_id, step_index,
                payload, payload_hash, provider_visible, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id, run_id, user_id, event_seq, event_type, created_at
        `, [
            runId,
            effectiveUserId,
            nextSeq,
            safeEventKey,
            safeEventType,
            String(turnId || '').slice(0, 160),
            Math.max(Number(stepIndex) || 0, 0),
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
        return result;
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
    recordAgentEvent
};
