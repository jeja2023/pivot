'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { query, execute, transaction, queryWithStatementTimeout } = require('../server/db/client');
const { runWithScopedSession } = require('../server/db/scoped-session');

test('持锁任务的数据库调用使用隔离连接，连接失效时不回退连接池', async () => {
    const calls = [];
    const client = { async query(sql, params) { calls.push({ sql, params }); return { rows: [{ value: params[0] }], rowCount: 1 }; } };
    await runWithScopedSession(client, async () => {
        assert.equal((await query('SELECT ? AS value', [7]))[0].value, 7);
        assert.equal(await execute('UPDATE example SET value = ?', [8]), 1);
        assert.equal((await queryWithStatementTimeout('SELECT ? AS value', [9], 0))[0].value, 9);
        await assert.rejects(() => transaction(async () => {}), /持锁任务/);
        await assert.rejects(() => queryWithStatementTimeout('SELECT 1', [], 100), /持锁任务/);
        client.query = async () => { throw new Error('connection lost'); };
        await assert.rejects(() => execute('UPDATE example SET value = ?', [10]), /connection lost/);
    });
    assert.deepEqual(calls.map(call => call.sql), ['SELECT $1 AS value', 'UPDATE example SET value = $1', 'SELECT $1 AS value']);
});
