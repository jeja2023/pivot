const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');

const clientsByUser = new Map();

function normalizeUserId(userOrId) {
    const value = typeof userOrId === 'object' ? userOrId?.id : userOrId;
    const id = Number(value);
    return Number.isFinite(id) && id > 0 ? id : 0;
}

function encodeSse(type, payload = {}) {
    return [
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

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const client = { res, createdAt: Date.now() };
    if (!clientsByUser.has(userId)) clientsByUser.set(userId, new Set());
    clientsByUser.get(userId).add(client);

    const heartbeatMs = Number.isFinite(options.heartbeatMs) ? options.heartbeatMs : 25000;
    const write = (type, payload) => {
        if (res.writableEnded || res.destroyed) {
            removeClient(userId, client);
            return;
        }
        try {
            res.write(encodeSse(type, payload));
        } catch (err) {
            logger.debug({ err: err.message, userId }, '实时 SSE 客户端写入失败');
            removeClient(userId, client);
        }
    };
    client.write = write;

    write('connected', { userId });
    const timer = heartbeatMs > 0 ? setInterval(() => write('heartbeat', {}), heartbeatMs) : null;
    timer?.unref?.();

    const unsubscribe = () => {
        if (timer) clearInterval(timer);
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
