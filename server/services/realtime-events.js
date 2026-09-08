const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');
const { createSseResponseWriter } = require('./sse-response');

const clientsByUser = new Map();
const MAX_REALTIME_CLIENTS_PER_USER = Math.max(Number.parseInt(process.env.REALTIME_MAX_CLIENTS_PER_USER || '8', 10) || 8, 1);
const MAX_REALTIME_CLIENTS = Math.max(Number.parseInt(process.env.REALTIME_MAX_CLIENTS || '1000', 10) || 1000, MAX_REALTIME_CLIENTS_PER_USER);

function normalizeUserId(userOrId) {
    const value = typeof userOrId === 'object' ? userOrId?.id : userOrId;
    const id = Number(value);
    return Number.isFinite(id) && id > 0 ? id : 0;
}

function encodeSse(type, payload = {}) {
    const eventId = payload.eventId || (payload.runId && payload.eventSeq ? `${payload.runId}:${payload.eventSeq}` : '');
    return [
        ...(eventId ? [`id: ${String(eventId).replace(/[\r\n]/g, '')}`] : []),
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
    set.delete(client);
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
    const currentTotal = getRealtimeStats().clients;
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
    if (!clientsByUser.has(userId)) clientsByUser.set(userId, new Set());
    clientsByUser.get(userId).add(client);

    const write = (type, payload) => {
        if (!writer.isWritable()) {
            removeClient(userId, client);
            return;
        }
        if (!writer.writeRaw(encodeSse(type, payload))) {
            removeClient(userId, client);
        }
    };
    client.write = write;

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
        writer.cleanup();
        removeClient(userId, client);
    };
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
    let clients = 0;
    for (const set of clientsByUser.values()) clients += set.size;
    return {
        users: clientsByUser.size,
        clients
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
