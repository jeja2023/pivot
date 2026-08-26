const test = require('node:test');
const assert = require('node:assert/strict');

// 用桩连接池替换 pg-connection，验证 transaction() 在回滚失败时是否把坏连接交还给
// 连接池销毁。真库很难稳定复现「ROLLBACK 本身失败」，但这正是生产上坏连接累积、
// 最终只能重启进程的路径，必须有回归保护。
const pgConnectionPath = require.resolve('../server/db/pg-connection');
const clientPath = require.resolve('../server/db/client');

function loadClientWithFakePool(fakePool) {
    const savedPgConnection = require.cache[pgConnectionPath];
    const savedClient = require.cache[clientPath];
    delete require.cache[clientPath];
    require.cache[pgConnectionPath] = {
        id: pgConnectionPath,
        filename: pgConnectionPath,
        loaded: true,
        exports: { getPgPool: () => fakePool, peekPgPool: () => fakePool }
    };
    const client = require(clientPath);
    const restore = () => {
        delete require.cache[clientPath];
        if (savedPgConnection) require.cache[pgConnectionPath] = savedPgConnection;
        else delete require.cache[pgConnectionPath];
        if (savedClient) require.cache[clientPath] = savedClient;
    };
    return { client, restore };
}

function createFakeClient({ failOn = null, rollbackError = null } = {}) {
    const statements = [];
    const releases = [];
    return {
        statements,
        releases,
        async query(sql) {
            statements.push(sql);
            if (sql === 'ROLLBACK' && rollbackError) throw rollbackError;
            if (failOn && sql === failOn) throw new Error(`语句执行失败: ${sql}`);
            return { rows: [], rowCount: 0 };
        },
        release(err) { releases.push(err); }
    };
}

test('事务正常提交后连接无错误归还连接池', async () => {
    const fakeClient = createFakeClient();
    const { client, restore } = loadClientWithFakePool({ connect: async () => fakeClient });
    try {
        const result = await client.transaction(async trx => {
            await trx.execute('UPDATE users SET status = ? WHERE id = ?', ['active', 1]);
            return 'done';
        });
        assert.equal(result, 'done');
        assert.deepEqual(fakeClient.statements, ['BEGIN', 'UPDATE users SET status = $1 WHERE id = $2', 'COMMIT']);
        assert.deepEqual(fakeClient.releases, [undefined]);
    } finally {
        restore();
    }
});

test('业务失败但回滚成功时，连接正常归还且抛出原始错误', async () => {
    const fakeClient = createFakeClient();
    const { client, restore } = loadClientWithFakePool({ connect: async () => fakeClient });
    try {
        await assert.rejects(
            client.transaction(async () => { throw new Error('业务校验失败'); }),
            /业务校验失败/
        );
        assert.deepEqual(fakeClient.statements, ['BEGIN', 'ROLLBACK']);
        assert.deepEqual(fakeClient.releases, [undefined]);
    } finally {
        restore();
    }
});

test('回滚本身失败时必须把错误传给 release()，让连接池销毁这条坏连接', async () => {
    const rollbackError = new Error('Connection terminated unexpectedly');
    const fakeClient = createFakeClient({ rollbackError });
    const { client, restore } = loadClientWithFakePool({ connect: async () => fakeClient });
    try {
        // 原始业务错误不能被回滚错误吞掉，否则排查时只看到 ROLLBACK 失败
        await assert.rejects(
            client.transaction(async () => { throw new Error('业务校验失败'); }),
            /业务校验失败/
        );
        assert.deepEqual(fakeClient.statements, ['BEGIN', 'ROLLBACK']);
        assert.equal(fakeClient.releases.length, 1);
        assert.equal(fakeClient.releases[0], rollbackError);
    } finally {
        restore();
    }
});

test('COMMIT 失败后回滚失败，同样销毁连接', async () => {
    const rollbackError = new Error('current transaction is aborted');
    const fakeClient = createFakeClient({ failOn: 'COMMIT', rollbackError });
    const { client, restore } = loadClientWithFakePool({ connect: async () => fakeClient });
    try {
        await assert.rejects(client.transaction(async () => 'ok'), /语句执行失败: COMMIT/);
        assert.equal(fakeClient.releases[0], rollbackError);
    } finally {
        restore();
    }
});
