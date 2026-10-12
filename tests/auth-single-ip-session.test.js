'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const enabled = process.env.PIVOT_TEST_PG_SYNC === 'true';

test('单 IP 会话在新 IP 登录时立即撤销旧 IP 的访问和刷新令牌', { skip: !enabled }, async () => {
    const { execute } = require('../server/db/client');
    const { closePgPool } = require('../server/db/pg-connection');
    const { login, register, resolveAuthenticatedUserAsync } = require('../server/auth');
    const suffix = `${process.pid}${Date.now()}`.slice(-12);
    const username = `single_ip_${suffix}`;
    const password = 'Pivot-Test-123!';
    const reqFor = (token, ip) => ({
        headers: { cookie: `pivot_access_token=${token}` },
        socket: { remoteAddress: ip }
    });
    let userId = null;
    try {
        const user = await register(username, password, '单 IP 会话测试', 'QA');
        userId = user.id;
        const first = await login(username, password, { clientIp: '10.25.0.11', deviceId: 'a'.repeat(24) });
        assert.equal((await resolveAuthenticatedUserAsync(reqFor(first.accessToken, '10.25.0.11'))).code, 'AUTH_OK');

        const replacement = await login(username, password, { clientIp: '10.25.0.12', deviceId: 'b'.repeat(24) });
        assert.equal(replacement.sessionReplaced, true);
        assert.equal((await resolveAuthenticatedUserAsync(reqFor(first.accessToken, '10.25.0.11'))).user, null);
        assert.equal((await resolveAuthenticatedUserAsync(reqFor(replacement.accessToken, '10.25.0.12'))).code, 'AUTH_OK');
        assert.equal((await resolveAuthenticatedUserAsync(reqFor(replacement.accessToken, '10.25.0.11'))).code, 'AUTH_IP_MISMATCH');
    } finally {
        if (userId) {
            await execute('DELETE FROM refresh_tokens WHERE user_id = ?', [userId]);
            await execute('DELETE FROM users WHERE id = ?', [userId]);
        }
        await closePgPool();
    }
});

test('单 IP 会话拒绝未登记代理提供的转发来源地址', () => {
    const { getSessionClientIp } = require('../server/auth');
    const previous = process.env.TRUSTED_PROXY_IPS;
    try {
        process.env.TRUSTED_PROXY_IPS = '10.0.0.10';
        const forwarded = {
            headers: { 'x-forwarded-for': '203.0.113.10' },
            socket: { remoteAddress: '10.0.0.11' }
        };
        assert.equal(getSessionClientIp(forwarded), '');
        forwarded.socket.remoteAddress = '10.0.0.10';
        assert.equal(getSessionClientIp(forwarded), '203.0.113.10');
    } finally {
        if (previous === undefined) delete process.env.TRUSTED_PROXY_IPS;
        else process.env.TRUSTED_PROXY_IPS = previous;
    }
});

test('单 IP 会话访问令牌生成携带来源地址声明并在无 IP 时省略', () => {
    const { generateAccessToken } = require('../server/auth');
    const jwt = require('jsonwebtoken');
    const tokenWithIp = generateAccessToken({ id: 99, username: 'tester' }, { sessionIp: '198.51.100.5' });
    const decodedWithIp = jwt.decode(tokenWithIp);
    assert.equal(decodedWithIp.sip, '198.51.100.5');

    const tokenWithoutIp = generateAccessToken({ id: 99, username: 'tester' });
    const decodedWithoutIp = jwt.decode(tokenWithoutIp);
    assert.equal(decodedWithoutIp.sip, undefined);
});

test.after(async () => {
    const { closePgPool } = require('../server/db/pg-connection');
    await closePgPool();
});
