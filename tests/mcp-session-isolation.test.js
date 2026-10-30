const test = require('node:test');
const assert = require('node:assert/strict');
const { keyForMcpSession, getMcpSession, setMcpSession, clearMcpSessions } = require('../server/services/mcp-session-cache');

test('MCP 会话按用户、账号、地址及凭据隔离并在空闲后过期', () => {
    clearMcpSessions();
    const base = { serverId: 1, url: 'https://example.test', userId: 1, accountId: 1, authorization: 'secret', protocolVersion: '2024-11-05' };
    const key = keyForMcpSession(base);
    setMcpSession(key, 'session', 1000);
    for (const change of [{ userId: 2 }, { accountId: 2 }, { url: 'https://other.test' }, { authorization: 'rotated' }]) {
        assert.equal(getMcpSession(keyForMcpSession({ ...base, ...change }), 1001), undefined);
    }
    assert.equal(key.includes('secret'), false);
    assert.equal(getMcpSession(key, 1001), 'session');
    assert.equal(getMcpSession(key, 1001 + 30 * 60 * 1000), undefined);
    assert.notEqual(keyForMcpSession({ ...base, userId: null }), keyForMcpSession({ ...base, userId: null }));
    clearMcpSessions();
});
