'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-min-32-chars-for-testing-node';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const jwt = require('jsonwebtoken');
const { guardRealtimeSession, revokeRealtimeSessions } = require('../server/services/realtime-session');

class Response extends EventEmitter {
    constructor() { super(); this.writableEnded = false; this.destroyed = false; }
    end() { this.writableEnded = true; this.emit('finish'); }
}
const request = (id, token = '') => ({ user: { id, role: 'user', unit: '测试', token_version: 0 }, headers: { authorization: `Bearer ${token}` } });
const closed = response => new Promise(resolve => { if (response.writableEnded) resolve(); else response.once('finish', resolve); });

test('会话撤销按账号和令牌关闭既有事件连接，结束后清理登记', () => {
    const a = new Response(), b = new Response(), other = new Response();
    guardRealtimeSession(request(71, 'first'), a); guardRealtimeSession(request(71, 'second'), b); guardRealtimeSession(request(72), other);
    assert.equal(revokeRealtimeSessions(71, { token: 'first' }), 1);
    assert.equal(a.writableEnded, true); assert.equal(b.writableEnded, false); assert.equal(other.writableEnded, false);
    assert.equal(revokeRealtimeSessions(71), 1); assert.equal(revokeRealtimeSessions(71), 0);
    other.end(); assert.equal(revokeRealtimeSessions(72), 0);
});

test('周期认证拒绝令牌代次变化、停用和认证故障，不能继续保持连接', { timeout: 2000 }, async () => {
    for (const kind of ['version', 'disabled', 'failure']) {
        const req = request(73), res = new Response();
        guardRealtimeSession(req, res, { intervalMs: 5, authenticate: async () => {
            if (kind === 'failure') throw new Error('受控认证故障');
            return { user: { ...req.user, ...(kind === 'disabled' ? { status: 'disabled' } : { token_version: 1 }) } };
        } });
        await closed(res); assert.equal(revokeRealtimeSessions(73), 0);
    }
});

test('令牌到期主动结束连接，迟到的认证成功不能重新登记', { timeout: 2000 }, async () => {
    const token = jwt.sign({ id: 74, exp: Math.floor(Date.now() / 1000) - 1 }, 'synthetic-test-key');
    const req = request(74, token), res = new Response();
    guardRealtimeSession(req, res, { intervalMs: 100, authenticate: async () => ({ user: req.user }) });
    await closed(res); assert.equal(revokeRealtimeSessions(74), 0);
});
