'use strict';

const { normalizeRealtimeCursor } = require('./realtime-cursor');

// 同一节点、同一用户和相同游标的并发读取共享一次在途查询；不缓存结果，
// 不同游标仍分别读取，避免慢连接或撤权期间跳过事件。
const pendingByDatabase = new WeakMap();
function readPendingEvents(database, userId, cursor) {
    let pending = pendingByDatabase.get(database);
    if (!pending) { pending = new Map(); pendingByDatabase.set(database, pending); }
    const key = JSON.stringify([String(userId), cursor]);
    const current = pending.get(key);
    if (current) return current;
    const result = Promise.resolve().then(() => database.query(`
        SELECT id::text AS id, run_id, event_seq, event_type, payload
        FROM agent_events WHERE user_id = ? AND id > ?
        ORDER BY agent_events.id ASC LIMIT 200
    `, [userId, cursor]));
    pending.set(key, result);
    const clear = () => { if (pending.get(key) === result) pending.delete(key); };
    result.then(clear, clear);
    return result;
}

// 在每条连接上按用户游标读取已提交事件；查询失败时断开，客户端用最后 ID 重连。
function startDurableEventFeed({ userId, after, subscription, database, response, intervalMs = 1000, maxBufferedBytes = 4 * 1024 * 1024 }) {
    let cursor = normalizeRealtimeCursor(after);
    let timer = null;
    let stopped = false;
    let running = false;
    async function tick() {
        if (stopped || running || !subscription.isActive()) return;
        running = true;
        try {
            const rows = await readPendingEvents(database, userId, cursor);
            if (stopped || !subscription.isActive()) return;
            let bytes = 0;
            let last = null;
            for (const row of rows) {
                const size = Buffer.byteLength(JSON.stringify(row));
                if (size > maxBufferedBytes) throw new Error('实时事件过大');
                if (last && bytes + size > maxBufferedBytes) break;
                subscription.writeReplay(row);
                bytes += size;
                last = row;
            }
            if (!await subscription.waitForDrain()) return;
            if (last) {
                const next = normalizeRealtimeCursor(last.id);
                if (next === '0' || BigInt(next) <= BigInt(cursor)) throw new Error('实时事件游标无效');
                cursor = next;
            }
            if (!stopped && subscription.isActive()) {
                timer = setTimeout(tick, rows.length === 200 || (last && last !== rows[rows.length - 1]) ? 0 : intervalMs);
                timer.unref?.();
            }
        } catch (_) {
            if (!stopped) { subscription(); response.destroy(); }
        } finally { running = false; }
    }
    const stop = () => { stopped = true; if (timer) clearTimeout(timer); timer = null; };
    response.once('close', stop);
    response.once('finish', stop);
    tick().catch(() => { if (!stopped) { subscription(); response.destroy(); } });
    return stop;
}

module.exports = { startDurableEventFeed };
