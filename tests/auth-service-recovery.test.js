'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('认证存储暂不可用返回503并保留会话，真正失效的刷新令牌仍返回401并清理Cookie', async () => {
    const dbPath = require.resolve('../server/db/client'), authPath = require.resolve('../server/auth'), routePath = require.resolve('../server/routes/auth');
    const saved = [dbPath, authPath, routePath].map(key => [key, require.cache[key]]);
    let down = true;
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
        queryOne: async () => { if (down) throw new Error('数据库连接超时'); return { id: 7, username: 'test', role: 'user', status: 'active', token_version: 0 }; },
        query: async () => [], execute: async () => 1,
        transaction: async callback => { if (down) throw new Error('数据库连接不可用'); return callback({ queryOne: async () => null }); }
    } };
    delete require.cache[authPath]; delete require.cache[routePath];
    try {
        const auth = require('../server/auth');
        const token = auth.generateAccessToken({ id: 7, username: 'test', token_version: 0 }, { sessionIp: '127.0.0.1' });
        const request = { headers: { cookie: `${auth.AUTH_COOKIE_NAME}=${token}` }, socket: { remoteAddress: '127.0.0.1' } };
        await assert.rejects(auth.resolveAuthenticatedUserAsync(request), error => error.status === 503 && error.code === 'AUTH_SERVICE_UNAVAILABLE' && !/timeout/.test(error.message));
        const response = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
        let allowed = false;
        await auth.authMiddleware(request, response, () => { allowed = true; });
        assert.equal(response.statusCode, 503); assert.equal(allowed, false);
        down = false;
        assert.equal((await auth.resolveAuthenticatedUserAsync(request)).code, 'AUTH_OK');
        const invalid = await auth.resolveAuthenticatedUserAsync({ ...request, headers: { cookie: `${auth.AUTH_COOKIE_NAME}=invalid-token` } });
        assert.equal(invalid.user, null);
        const pass = (_req, _res, next) => next();
        const router = require('../server/routes/auth').createAuthRouter({ authMiddleware: pass, loginLimiter: pass, isPublicRegistrationEnabled: () => false, logAction() {} });
        const handlers = router.stack.find(layer => layer.route?.path === '/auth/refresh').route.stack;
        const invoke = async () => {
            const cleared = [];
            const result = await new Promise((resolve, reject) => {
                const res = { status(code) { this.statusCode = code; return this; }, clearCookie(name) { cleared.push(name); return this; }, json(body) { resolve({ status: this.statusCode || 200, body, cleared }); } };
                handlers[handlers.length - 1].handle({ headers: { cookie: `${auth.REFRESH_COOKIE_NAME}=test-refresh` }, socket: { remoteAddress: '127.0.0.1' } }, res, reject);
            });
            return result;
        };
        down = true;
        const unavailable = await invoke();
        assert.equal(unavailable.status, 503); assert.equal(unavailable.cleared.length, 0);
        assert.equal(unavailable.body.code, 'AUTH_SERVICE_UNAVAILABLE');
        down = false;
        const expired = await invoke();
        assert.equal(expired.status, 401); assert.ok(expired.cleared.includes(auth.AUTH_COOKIE_NAME));
        assert.equal(expired.body.code, 'REFRESH_TOKEN_INVALID');
    } finally {
        for (const [key, entry] of saved) { if (entry) require.cache[key] = entry; else delete require.cache[key]; }
    }
});
