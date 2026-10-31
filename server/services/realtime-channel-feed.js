'use strict';

const { createSseResponseWriter } = require('./sse-response');
const { normalizeRealtimeCursor } = require('./realtime-cursor');
const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');
const activeUsers = new Map();
let activeCount = 0;
const MAX_CONNECTIONS = 1000;
const MAX_PER_USER = 8;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
let lastCleanup = 0;
let cleanup = null;

function cleanupRetired(database) {
    if (cleanup || Date.now() - lastCleanup < 60000) return;
    lastCleanup = Date.now();
    cleanup = database.query(`DELETE FROM realtime_channel_deliveries WHERE id IN (
        SELECT id FROM realtime_channel_deliveries WHERE retired_at < NOW() - INTERVAL '7 days' ORDER BY retired_at LIMIT 500
    ) RETURNING id`).catch(error => logger.warn({ code: error.code || 'CHANNEL_REPLAY_CLEANUP_FAILED' }, '渠道补发记录清理失败')).finally(() => { cleanup = null; });
}

function payload(row) {
    const parseChannelJson = (value, fallback) => {
        if (value && typeof value === 'object') return value;
        try { return JSON.parse(value || ''); } catch (_) { return fallback; }
    };
    const scrub = value => {
        if (Array.isArray(value)) return value.map(scrub);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'outboundTargetEncrypted').map(([key, item]) => [key, scrub(item)]));
    };
    const interaction = scrub(parseChannelJson(row.interaction, {}));
    return { type: 'agent.channel', timestamp: getBeijingTimestamp(), deliveryId: String(row.delivery_id),
        eventType: row.event_type, subject: row.subject, body: row.body, attachments: parseChannelJson(row.attachments, []), interaction };
}

async function startChannelFeed({ userId, after, suppliedCursor, database, response, wakeup, intervalMs = 5000 }) {
    const user = String(userId);
    if (activeCount >= MAX_CONNECTIONS || (activeUsers.get(user) || 0) >= MAX_PER_USER) {
        response.status(429).json({ error: '渠道实时连接数已达到上限' });
        return;
    }
    activeCount += 1;
    activeUsers.set(user, (activeUsers.get(user) || 0) + 1);
    let closed = false; let running = false; let pending = false; let timer = null; let unsubscribe = null;
    let writer;
    const closeChannelFeed = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        unsubscribe?.(); writer?.cleanup();
        activeCount -= 1;
        const next = (activeUsers.get(user) || 1) - 1;
        if (next) activeUsers.set(user, next); else activeUsers.delete(user);
    };
    response.once('close', closeChannelFeed); response.once('finish', closeChannelFeed);
    try {
        const reconnect = suppliedCursor !== undefined && /^\d{1,19}$/.test(String(suppliedCursor))
            && (after !== '0' || /^0+$/.test(String(suppliedCursor)));
        const bounds = reconnect ? [] : await database.query(`SELECT COALESCE(MIN(r.id) - 1, 0)::text AS max_id
            FROM realtime_channel_deliveries r JOIN agent_channel_deliveries d ON d.id = r.delivery_id
            JOIN agent_channel_bindings b ON b.id = d.binding_id AND b.user_id = d.user_id AND b.channel_type = 'web' AND b.status = 'active'
            WHERE r.user_id = ? AND d.user_id = ? AND (r.retired_at IS NULL OR r.retired_at >= NOW() - INTERVAL '7 days')`, [userId, userId]);
        let cursor = reconnect ? after : normalizeRealtimeCursor(bounds[0]?.max_id);
        if (closed) return;
        writer = createSseResponseWriter(response, { heartbeatMs: 25000 });
        writer.writeRaw(`id: ${cursor}\nevent: channel.connected\ndata: {}\n\n`);
        async function tick() {
            if (closed || running || !writer.isWritable()) return;
            running = true;
            try {
                const rows = await database.query(`
                    SELECT r.id::text AS cursor, d.id::text AS delivery_id, d.event_type, d.subject, d.body, d.attachments, d.interaction
                    FROM realtime_channel_deliveries r JOIN agent_channel_deliveries d ON d.id = r.delivery_id
                    JOIN agent_channel_bindings b ON b.id = d.binding_id AND b.user_id = d.user_id AND b.channel_type = 'web' AND b.status = 'active'
                    JOIN users u ON u.id = d.user_id AND u.deleted_at IS NULL AND COALESCE(u.status, 'active') = 'active'
                    WHERE r.user_id = ? AND d.user_id = ? AND r.id > ? ORDER BY r.id ASC LIMIT 100
                `, [userId, userId, cursor]);
                if (closed || !writer.isWritable()) return;
                for (const row of rows) {
                    const next = normalizeRealtimeCursor(row.cursor);
                    if (next === '0' || BigInt(next) <= BigInt(cursor)) throw new Error('渠道事件游标无效');
                    const frame = `id: ${next}\nevent: agent.channel\ndata: ${JSON.stringify(payload(row))}\n\n`;
                    if (Buffer.byteLength(frame) > MAX_EVENT_BYTES) throw new Error('渠道事件超过大小上限');
                    if (!writer.writeRaw(frame)) return;
                    if (!await writer.waitForDrain()) return;
                    cursor = next;
                }
                if (!closed) { timer = setTimeout(tick, pending || rows.length === 100 ? 0 : intervalMs); timer.unref?.(); pending = false; }
            } catch (_) { closeChannelFeed(); response.destroy(); }
            finally { running = false; }
        }
        function wake() {
            if (closed) return;
            if (running) { pending = true; return; }
            if (timer) clearTimeout(timer);
            timer = null;
            void tick().catch(() => { closeChannelFeed(); response.destroy(); });
        }
        if (wakeup) unsubscribe = wakeup.subscribe(userId, wake);
        if (database.cleanupEnabled === true) cleanupRetired(database);
        await tick();
    } catch (error) { closeChannelFeed(); throw error; }
}

module.exports = { cleanupRetired, startChannelFeed };
