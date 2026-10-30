const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');
const { createSseResponseWriter } = require('./sse-response');
const { normalizeRealtimeCursor } = require('./realtime-cursor');

const clientsByUser = new Map();
let totalConnectedClients = 0;
const MAX_REALTIME_CLIENTS_PER_USER = Math.max(Number.parseInt(process.env.REALTIME_MAX_CLIENTS_PER_USER || '8', 10) || 8, 1);
const MAX_REALTIME_CLIENTS = Math.max(Number.parseInt(process.env.REALTIME_MAX_CLIENTS || '1000', 10) || 1000, MAX_REALTIME_CLIENTS_PER_USER);
const MAX_REPLAY_BUFFER_EVENTS = 1000;
const MAX_REPLAY_BUFFER_BYTES = 4 * 1024 * 1024;

function normalizeUserId(userOrId) {
    const value = typeof userOrId === 'object' ? userOrId?.id : userOrId;
    const id = Number(value);
    return Number.isFinite(id) && id > 0 ? id : 0;
}

function encodeSse(type, payload = {}) {
    // 只有持久化 agent.event 的数据库 ID 可作为重连游标；其他事件的
    // 业务标识不能覆盖 EventSource 自动携带的 Last-Event-ID。
    const eventId = type === 'agent.event' ? normalizeRealtimeCursor(payload.eventId) : '0';
    return [
        ...(eventId !== '0' ? [`id: ${eventId}`] : []),
        `event: ${type}`,
        `data: ${JSON.stringify({
            type,
            timestamp: getBeijingTimestamp(),
            ...payload
        })}`,
        '',
        ''
    ].join('\n');
}

function removeClient(userId, client) {
    const set = clientsByUser.get(userId);
    if (!set) return;
    if (set.delete(client)) {
        totalConnectedClients = Math.max(0, totalConnectedClients - 1);
    }
    if (set.size === 0) clientsByUser.delete(userId);
}

function subscribeUserEvents(user, res, options = {}) {
    const userId = normalizeUserId(user);
    if (!userId) {
        res.status(401).end();
        return () => {};
    }

    // 必须在创建 writer 和登记客户端之前判定容量；否则被 429 拒绝的响应
    // 会残留在 clientsByUser 中，反而使连接上限失效并造成内存泄漏。
    const currentTotal = totalConnectedClients;
    const currentUserCount = clientsByUser.get(userId)?.size || 0;
    if (currentUserCount >= MAX_REALTIME_CLIENTS_PER_USER || currentTotal >= MAX_REALTIME_CLIENTS) {
        res.status?.(429);
        res.json?.({ error: '实时事件连接数已达到上限，请关闭旧页面后重试', code: 'REALTIME_CONNECTION_LIMIT' });
        res.end?.();
        return () => {};
    }

    const heartbeatMs = Number.isFinite(options.heartbeatMs) ? options.heartbeatMs : 25000;
    const writer = createSseResponseWriter(res, {
        heartbeatMs,
        heartbeatFactory: () => encodeSse('heartbeat', {}),
        onError: err => logger.debug({ err: err.message, userId }, '实时 SSE 客户端写入失败')
    });

    const client = { res, createdAt: Date.now() };
    let buffering = options.bufferAgentEvents === true;
    let bufferedBytes = 0;
    const bufferedEvents = [];
    if (!clientsByUser.has(userId)) clientsByUser.set(userId, new Set());
    clientsByUser.get(userId).add(client);
    totalConnectedClients += 1;

    const write = (type, payload) => {
        if (!writer.isWritable()) {
            removeClient(userId, client);
            return;
        }
        if (!writer.writeRaw(encodeSse(type, payload))) {
            removeClient(userId, client);
        }
    };
    client.write = (type, payload) => {
        if (!buffering || type !== 'agent.event') return write(type, payload);
        const serialized = JSON.stringify(payload);
        const bytes = Buffer.byteLength(serialized);
        if (bufferedEvents.length >= MAX_REPLAY_BUFFER_EVENTS || bufferedBytes + bytes > MAX_REPLAY_BUFFER_BYTES) {
            buffering = false;
            bufferedEvents.length = 0;
            removeClient(userId, client);
            writer.cleanup();
            res.destroy?.();
            return;
        }
        bufferedBytes += bytes;
        bufferedEvents.push(JSON.parse(serialized));
    };

    write('connected', { userId });
    const initialEvents = Array.isArray(options.initialEvents) ? options.initialEvents : [];
    for (const event of initialEvents) {
        write('agent.event', {
            runId: event.run_id || event.runId || '',
            eventId: event.id || event.event_id || '',
            eventSeq: event.event_seq || event.eventSeq || 0,
            eventType: event.event_type || event.eventType || '',
            payload: event.payload || {},
            replayable: true,
            replay: true
        });
    }

    const unsubscribe = () => {
        buffering = false;
        bufferedEvents.length = 0;
        writer.cleanup();
        removeClient(userId, client);
    };
    unsubscribe.writeReplay = event => write('agent.event', {
        runId: event.run_id || event.runId || '',
        eventId: event.id || event.event_id || '',
        eventSeq: event.event_seq || event.eventSeq || 0,
        eventType: event.event_type || event.eventType || '',
        payload: event.payload || {},
        replayable: true,
        replay: true
    });
    unsubscribe.finishReplay = (replayedThrough = '0') => {
        buffering = false;
        let lastId = BigInt(normalizeRealtimeCursor(replayedThrough));
        bufferedEvents.sort((a, b) => {
            const aId = BigInt(normalizeRealtimeCursor(a.eventId));
            const bId = BigInt(normalizeRealtimeCursor(b.eventId));
            return aId < bId ? -1 : aId > bId ? 1 : 0;
        });
        for (const payload of bufferedEvents) {
            const id = BigInt(normalizeRealtimeCursor(payload.eventId));
            if (id && id <= lastId) continue;
            write('agent.event', payload);
            if (id) lastId = id;
        }
        bufferedEvents.length = 0;
        bufferedBytes = 0;
    };
    unsubscribe.isActive = () => writer.isWritable();
    unsubscribe.waitForDrain = () => writer.waitForDrain();
    res.on?.('close', unsubscribe);
    res.on?.('finish', unsubscribe);
    return unsubscribe;
}

function publishUserEvent(userOrId, type, payload = {}) {
    const userId = normalizeUserId(userOrId);
    if (!userId || !type) return 0;
    const clients = clientsByUser.get(userId);
    if (!clients || clients.size === 0) return 0;
    let delivered = 0;
    for (const client of [...clients]) {
        client.write(type, payload);
        delivered += 1;
    }
    return delivered;
}

function getRealtimeStats() {
    return {
        users: clientsByUser.size,
        clients: totalConnectedClients
    };
}

function closeRealtimeEventClients({ reason = 'server_shutdown', retryAfterMs = 0 } = {}) {
    let closed = 0;
    for (const [userId, clients] of [...clientsByUser.entries()]) {
        for (const client of [...clients]) {
            try {
                client.write?.('server.shutdown', { reason, retryAfterMs });
            } catch (_) {}
            try { client.res?.end?.(); } catch (_) {}
            removeClient(userId, client);
            closed += 1;
        }
    }
    return closed;
}

module.exports = {
    closeRealtimeEventClients,
    getRealtimeStats,
    publishUserEvent,
    subscribeUserEvents
};
