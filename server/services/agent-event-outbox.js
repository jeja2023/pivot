const crypto = require('crypto');
const { query, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { publishUserEvent } = require('./realtime-events');

const DEFAULT_CLAIM_LIMIT = 50;
const DEFAULT_POLL_MS = 1000;
const CLAIM_TIMEOUT_MS = 60 * 1000;
const OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1000;
const OUTBOX_CLEANUP_INTERVAL_MS = 60 * 1000;

function normalizeWorkerId(value = '') {
    const source = String(value || '').trim();
    return source.slice(0, 128) || `agent-outbox-${process.pid}-${crypto.randomUUID()}`;
}

function parsePayload(value) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value || '{}'); } catch (_) { return {}; }
}

async function claimAgentEventOutbox({ workerId = '', limit = DEFAULT_CLAIM_LIMIT, transactionFn = transaction } = {}) {
    const safeWorkerId = normalizeWorkerId(workerId);
    const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_CLAIM_LIMIT, 1), 200);
    const now = getBeijingTimestamp();
    const staleBefore = getBeijingTimestamp(new Date(Date.now() - CLAIM_TIMEOUT_MS));
    return transactionFn(async trx => {
        await trx.execute(`
            UPDATE agent_event_outbox
            SET status = 'pending', locked_at = NULL, locked_by = '', available_at = ?, updated_at = ?
            WHERE status = 'claimed' AND locked_at IS NOT NULL AND locked_at < ?
        `, [now, now, staleBefore]);
        const rows = await trx.query(`
            SELECT id::text AS id, event_id::text AS event_id, run_id, user_id, event_seq, event_type, payload,
                   status, delivery_attempts, created_at
            FROM agent_event_outbox
            WHERE status = 'pending' AND (available_at IS NULL OR available_at <= ?)
            ORDER BY agent_event_outbox.id ASC
            LIMIT ?
            FOR UPDATE SKIP LOCKED
        `, [now, safeLimit]);
        if (rows.length) {
            await trx.execute(`
                UPDATE agent_event_outbox
                SET status = 'claimed', locked_at = ?, locked_by = ?,
                    delivery_attempts = COALESCE(delivery_attempts, 0) + 1, updated_at = ?
                WHERE id = ANY(?::bigint[])
            `, [now, safeWorkerId, now, rows.map(row => row.id)]);
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

async function markAgentEventOutboxDeliveredBatch(ids, workerId) {
    if (!ids.length) return [];
    const now = getBeijingTimestamp();
    return await query(`
        UPDATE agent_event_outbox
        SET status = 'delivered', delivered_at = ?, updated_at = ?
        WHERE id = ANY(?::bigint[]) AND status = 'claimed' AND locked_by = ?
        RETURNING id
    `, [now, now, ids, workerId]);
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
    const published = [];
    for (const row of rows) {
        try {
            await publish(row.user_id, 'agent.event', {
                runId: row.run_id,
                eventId: row.event_id,
                eventSeq: row.event_seq,
                eventType: row.event_type,
                payload: row.payload,
                replayable: true
            });
            published.push(row);
        } catch (error) {
            await failAgentEventOutbox(row.id, safeWorkerId, error);
        }
    }
    if (published.length) {
        try {
            const marked = await markAgentEventOutboxDeliveredBatch(published.map(row => row.id), safeWorkerId);
            delivered += marked.length;
        } catch (_) {
            // 批量写失败时保留原来的单条重试行为；异常退出可重复投递但不会丢失事件。
            for (const row of published) {
                try {
                    const marked = await markAgentEventOutboxDelivered(row.id, safeWorkerId);
                    delivered += marked.length;
                } catch (error) {
                    await failAgentEventOutbox(row.id, safeWorkerId, error);
                }
            }
        }
    }
    return { claimed: rows.length, delivered };
}

async function retireDeliveredAgentEvents({ limit = 500, now = Date.now() } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 1000);
    const before = getBeijingTimestamp(new Date(now - OUTBOX_RETENTION_MS));
    return transaction(async trx => {
        // 与幂等记录路径按相同顺序先锁事件，防止清理期间重试重新入队。
        const rows = await trx.query(`
            SELECT e.id::text AS event_id, o.id::text AS outbox_id
            FROM agent_event_outbox o JOIN agent_events e ON e.id = o.event_id
            WHERE o.status = 'delivered' AND o.delivered_at IS NOT NULL AND o.delivered_at < ?
            ORDER BY o.id LIMIT ? FOR UPDATE OF e SKIP LOCKED
        `, [before, safeLimit]);
        if (!rows.length) return 0;
        await trx.execute('UPDATE agent_events SET outbox_retired_at = ? WHERE id = ANY(?::bigint[])',
            [getBeijingTimestamp(new Date(now)), rows.map(row => row.event_id)]);
        await trx.execute("DELETE FROM agent_event_outbox WHERE status = 'delivered' AND id = ANY(?::bigint[])",
            [rows.map(row => row.outbox_id)]);
        return rows.length;
    });
}

function createAgentEventOutboxDispatcher({
    workerId = '',
    intervalMs = Number(process.env.AGENT_EVENT_OUTBOX_POLL_MS || DEFAULT_POLL_MS),
    publish = publishUserEvent,
    logger = console,
    dispatchBatch = dispatchAgentEventOutboxBatch,
    retireEvents = retireDeliveredAgentEvents
} = {}) {
    const safeWorkerId = normalizeWorkerId(workerId);
    const safeInterval = Math.min(Math.max(Number(intervalMs) || DEFAULT_POLL_MS, 250), 30000);
    let timer = null;
    let inFlight = null;
    let nextCleanupAt = 0;
    const tick = () => {
        if (inFlight) return inFlight;
        inFlight = (async () => {
            // 先让出一次微任务，确保同步抛错也不会在赋值之前清空 inFlight。
            await Promise.resolve();
            try {
                await dispatchBatch({ workerId: safeWorkerId, publish });
                if (Date.now() >= nextCleanupAt) {
                    const retired = await retireEvents();
                    nextCleanupAt = Date.now() + (retired >= 500 ? 5000 : OUTBOX_CLEANUP_INTERVAL_MS);
                }
            } catch (error) {
                logger.warn?.({ err: error, workerId: safeWorkerId }, 'Agent 事件 outbox 投递失败');
            } finally {
                inFlight = null;
            }
        })();
        return inFlight;
    };
    return {
        start() {
            if (timer) return timer;
            timer = setInterval(tick, safeInterval);
            timer.unref?.();
            void tick();
            return timer;
        },
        async stop() {
            if (timer) clearInterval(timer);
            timer = null;
            if (inFlight) await inFlight;
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
    retireDeliveredAgentEvents
};
