const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');
const { createSseResponseWriter } = require('./sse-response');

const clientsByUser = new Map();

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

module.exports = {
    getRealtimeStats,
    publishUserEvent,
    subscribeUserEvents
};
