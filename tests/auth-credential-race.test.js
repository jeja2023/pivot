'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('锁外密码验证后发生重置、撤销或删除时不得签发令牌', async () => {
    const authPath = require.resolve('../server/auth');
    const dbPath = require.resolve('../server/db/client');
    const hashPath = require.resolve('../server/services/password-hasher');
    const saved = [authPath, dbPath, hashPath].map(key => [key, require.cache[key]]);
    const user = { id: 718, username: 'race', password_hash: '$2b$12$old', status: 'active', token_version: 0 };
    let locked = { ...user }, writes = 0;
    const executor = { queryOne: async () => locked, query: async () => [], execute: async () => { writes++; return 1; } };
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { ...executor, queryOne: async () => ({ ...user }), transaction: callback => callback(executor) } };
    require.cache[hashPath] = { id: hashPath, filename: hashPath, loaded: true, exports: { comparePasswordOffThread: async () => true } };
    delete require.cache[authPath];
    try {
        const auth = require('../server/auth');
        for (const change of [{ password_hash: '$2b$12$new' }, { token_version: 1 }, { deleted_at: '2026-11-17' }, { status: 'disabled' }]) {
            locked = { ...user, ...change };
            await assert.rejects(auth.login('race', '旧密码', { clientIp: '127.0.0.1' }));
            assert.equal(writes, 0);
        }
        locked = { ...user, role: 'user', nickname: '当前资料', created_at: '2026-11-17 09:00:00' };
        const result = await auth.login('race', '当前密码', { clientIp: '127.0.0.1' });
        assert.equal(result.user.nickname, '当前资料');
        assert.equal(result.user.created_at, '2026-11-17 09:00:00');
        assert.equal(writes, 2);
    } finally { for (const [key, value] of saved) { if (value) require.cache[key] = value; else delete require.cache[key]; } }
});
