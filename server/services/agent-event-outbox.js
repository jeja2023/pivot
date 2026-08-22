const crypto = require('crypto');
const { query, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { publishUserEvent } = require('./realtime-events');

const DEFAULT_CLAIM_LIMIT = 50;
const DEFAULT_POLL_MS = 1000;
const CLAIM_TIMEOUT_MS = 60 * 1000;

function normalizeWorkerId(value = '') {
    const source = String(value || '').trim();
    return source.slice(0, 128) || `agent-outbox-${process.pid}-${crypto.randomUUID()}`;
}

function parsePayload(value) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value || '{}'); } catch (_) { return {}; }
}

async function claimAgentEventOutbox({ workerId = '', limit = DEFAULT_CLAIM_LIMIT } = {}) {
    const safeWorkerId = normalizeWorkerId(workerId);
    const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_CLAIM_LIMIT, 1), 200);
    const now = getBeijingTimestamp();
    const staleBefore = getBeijingTimestamp(new Date(Date.now() - CLAIM_TIMEOUT_MS));
    return transaction(async trx => {
        await trx.execute(`
            UPDATE agent_event_outbox
            SET status = 'pending', locked_at = NULL, locked_by = '', available_at = ?, updated_at = ?
            WHERE status = 'claimed' AND locked_at IS NOT NULL AND locked_at < ?
        `, [now, now, staleBefore]);
        const rows = await trx.query(`
            SELECT id, event_id, run_id, user_id, event_seq, event_type, payload,
                   status, delivery_attempts, created_at
            FROM agent_event_outbox
            WHERE status = 'pending' AND (available_at IS NULL OR available_at <= ?)
            ORDER BY id ASC
            LIMIT ?
            FOR UPDATE SKIP LOCKED
        `, [now, safeLimit]);
        for (const row of rows) {
            await trx.execute(`
                UPDATE agent_event_outbox
                SET status = 'claimed', locked_at = ?, locked_by = ?,
                    delivery_attempts = COALESCE(delivery_attempts, 0) + 1, updated_at = ?
                WHERE id = ?
            `, [now, safeWorkerId, now, row.id]);
        }
        return rows.map(row => ({ ...row, status: 'claimed', locked_by: safeWorkerId, payload: parsePayload(row.payload) }));
    });
}

async function markAgentEventOutboxDelivered(id, workerId = '') {
    const now = getBeijingTimestamp();
    return await query(`
        UPDATE agent_event_outbox
        SET status = 'delivered', delivered_at = ?, updated_at = ?
        WHERE id = ? AND status = 'claimed' AND locked_by = ?
        RETURNING id, event_id, run_id, event_seq, status, delivered_at
    `, [now, now, id, normalizeWorkerId(workerId)]);
}

async function failAgentEventOutbox(id, workerId = '', error, { retryDelayMs = 1000 } = {}) {
    const now = getBeijingTimestamp();
    const retryAt = getBeijingTimestamp(new Date(Date.now() + Math.min(Math.max(Number(retryDelayMs) || 1000, 100), 5 * 60 * 1000)));
    const message = String(error?.message || error || 'outbox delivery failed').slice(0, 1000);
    return await query(`
        UPDATE agent_event_outbox
        SET status = 'pending', available_at = ?, last_error = ?, locked_at = NULL,
            locked_by = '', updated_at = ?
        WHERE id = ? AND status = 'claimed' AND locked_by = ?
        RETURNING id, event_id, run_id, event_seq, status, last_error
    `, [retryAt, message, now, id, normalizeWorkerId(workerId)]);
}

async function dispatchAgentEventOutboxBatch({ workerId = '', limit = DEFAULT_CLAIM_LIMIT, publish = publishUserEvent } = {}) {
    const safeWorkerId = normalizeWorkerId(workerId);
    const rows = await claimAgentEventOutbox({ workerId: safeWorkerId, limit });
    let delivered = 0;
    for (const row of rows) {
        try {
            publish(row.user_id, 'agent.event', {
                runId: row.run_id,
                eventId: row.event_id,
                eventSeq: row.event_seq,
                eventType: row.event_type,
                payload: row.payload,
                replayable: true
            });
            await markAgentEventOutboxDelivered(row.id, safeWorkerId);
            delivered += 1;
        } catch (error) {
            await failAgentEventOutbox(row.id, safeWorkerId, error);
        }
    }
    return { claimed: rows.length, delivered };
}

function createAgentEventOutboxDispatcher({
    workerId = '',
    intervalMs = Number(process.env.AGENT_EVENT_OUTBOX_POLL_MS || DEFAULT_POLL_MS),
    publish = publishUserEvent,
    logger = console
} = {}) {
    const safeWorkerId = normalizeWorkerId(workerId);
    const safeInterval = Math.min(Math.max(Number(intervalMs) || DEFAULT_POLL_MS, 250), 30000);
    let timer = null;
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await dispatchAgentEventOutboxBatch({ workerId: safeWorkerId, publish });
        } catch (error) {
            logger.warn?.({ err: error, workerId: safeWorkerId }, 'Agent 事件 outbox 投递失败');
        } finally {
            running = false;
        }
    };
    return {
        start() {
            if (timer) return timer;
            timer = setInterval(tick, safeInterval);
            timer.unref?.();
            void tick();
            return timer;
        },
        stop() {
            if (!timer) return;
            clearInterval(timer);
            timer = null;
        },
        tick,
        workerId: safeWorkerId
    };
}

module.exports = {
    claimAgentEventOutbox,
    createAgentEventOutboxDispatcher,
    dispatchAgentEventOutboxBatch,
    failAgentEventOutbox,
    markAgentEventOutboxDelivered
};
