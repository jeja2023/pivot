'use strict';
const crypto = require('node:crypto');
const sessions = new Map();
const fingerprint = token => crypto.createHash('sha256').update(String(token || '')).digest('hex');

function guardRealtimeSession(req, res, { authenticate = request => require('../auth').resolveAuthenticatedUserAsync(request), intervalMs = 5000 } = {}) {
    const { getCookie, AUTH_COOKIE_NAME } = require('../auth');
    const token = req.headers?.authorization?.startsWith('Bearer ') ? req.headers.authorization.split(' ')[1] : getCookie(req, AUTH_COOKIE_NAME);
    const userId = String(req.user.id), entry = { closed: false, fingerprint: fingerprint(token), close: null };
    let checking = false, expiryTimer, checkDeadline;
    if (!sessions.has(userId)) sessions.set(userId, new Set());
    sessions.get(userId).add(entry);
    const cleanup = () => {
        if (entry.closed) return;
        entry.closed = true;
        clearInterval(timer); clearTimeout(expiryTimer); clearTimeout(checkDeadline);
        sessions.get(userId)?.delete(entry);
        if (!sessions.get(userId)?.size) sessions.delete(userId);
        res.removeListener('close', cleanup); res.removeListener('finish', cleanup);
    };
    entry.close = () => { cleanup(); if (!res.writableEnded && !res.destroyed) res.end(); };
    const timer = setInterval(async () => {
        if (entry.closed || checking) return;
        checking = true;
        checkDeadline = setTimeout(entry.close, 5000);
        checkDeadline.unref?.();
        try {
            const auth = await authenticate(req);
            if (!auth?.user || String(auth.user.id) !== userId || auth.user.status === 'disabled'
                || Number(auth.user.token_version || 0) !== Number(req.user.token_version || 0)
                || auth.user.role !== req.user.role || auth.user.unit !== req.user.unit) entry.close();
        } catch (_) { entry.close(); }
        finally { clearTimeout(checkDeadline); checking = false; }
    }, Math.max(1, intervalMs));
    timer.unref?.();
    const expiry = require('jsonwebtoken').decode(token || '')?.exp;
    const delay = Number(expiry) * 1000 - Date.now();
    if (Number.isFinite(delay) && delay <= 2147483647) { expiryTimer = setTimeout(entry.close, Math.max(0, delay)); expiryTimer.unref?.(); }
    res.once('close', cleanup); res.once('finish', cleanup);
    return { isActive: () => !entry.closed && !res.writableEnded && !res.destroyed };
}

function revokeRealtimeSessions(userId, { token } = {}) {
    const selected = token === undefined ? null : fingerprint(token);
    let count = 0;
    for (const entry of [...(sessions.get(String(userId)) || [])]) {
        if (selected !== null && entry.fingerprint !== selected) continue;
        entry.close(); count++;
    }
    return count;
}

module.exports = { guardRealtimeSession, revokeRealtimeSessions };
