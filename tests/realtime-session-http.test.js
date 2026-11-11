'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-min-32-chars-for-testing-node';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { queryOne, execute } = require('../server/db/client');
const { authMiddleware, generateAccessToken } = require('../server/auth');
const { createEventsRouter } = require('../server/routes/events');
const { createAuthRouter } = require('../server/routes/auth');
const { publishUserEvent } = require('../server/services/realtime-events');

test('真实 HTTP 退出全部设备后关闭已有 SSE，旧令牌不能重连或继续接收事件', { timeout: 15000, skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne("INSERT INTO users(username,password_hash,status,role,unit) VALUES (?,'hash','active','user','测试') RETURNING id,username,status,role,unit,token_version", [`sse_revoke_${crypto.randomUUID()}`]);
    const app = express(); app.use(express.json());
    app.use('/api', createEventsRouter({ authMiddleware, database: { query: async () => [] }, durableEvents: false, channelFeed: false, wakeup: null }));
    app.use('/api', createAuthRouter({ authMiddleware, logAction() {}, isPublicRegistrationEnabled: () => false, loginLimiter: (_req, _res, next) => next() }));
    const server = await new Promise(resolve => { const handle = app.listen(0, '127.0.0.1', () => resolve(handle)); });
    const base = `http://127.0.0.1:${server.address().port}`, controller = new AbortController();
    const headers = { Authorization: `Bearer ${generateAccessToken(user, { sessionIp: '127.0.0.1' })}` };
    try {
        const response = await fetch(`${base}/api/events`, { headers, signal: controller.signal }); assert.equal(response.status, 200);
        const reader = response.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /event: connected/);
        const logout = await fetch(`${base}/api/auth/logout-all`, { method: 'POST', headers }); assert.equal(logout.status, 200);
        assert.equal(publishUserEvent(user.id, 'agent.notification', { body: '撤销后的事件' }, { crossNode: false }), 0);
        let timer;
        try { assert.equal((await Promise.race([reader.read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('旧 SSE 未在撤销后关闭')), 1000); })])).done, true); }
        finally { clearTimeout(timer); }
        assert.equal((await fetch(`${base}/api/events`, { headers })).status, 401);
    } finally {
        controller.abort(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
        await execute('DELETE FROM users WHERE id=?', [user.id]);
    }
});
