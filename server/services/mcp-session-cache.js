const { createHash, randomUUID } = require('node:crypto');

const MAX_SESSIONS = 1000;
const IDLE_MS = 30 * 60 * 1000;
const sessions = new Map();

function keyForMcpSession({ serverId, url, userId, accountId, authorization, protocolVersion }) {
    // 匿名调用不得继承其他调用者的有状态会话。
    const identity = userId == null ? randomUUID() : String(userId);
    const credentialHash = createHash('sha256').update(String(authorization || '')).digest('hex');
    return JSON.stringify([String(serverId || ''), String(url || ''), identity, String(accountId || ''), credentialHash, String(protocolVersion || '')]);
}

function getMcpSession(key, now = Date.now()) {
    const entry = sessions.get(key);
    if (!entry) return undefined;
    sessions.delete(key);
    if (entry.expires <= now) return undefined;
    sessions.set(key, { ...entry, expires: now + IDLE_MS });
    return entry.id;
}

function setMcpSession(key, id, now = Date.now()) {
    sessions.delete(key);
    sessions.set(key, { id: String(id), expires: now + IDLE_MS });
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
}

function clearMcpSessions() { sessions.clear(); }

module.exports = { keyForMcpSession, getMcpSession, setMcpSession, clearMcpSessions };
