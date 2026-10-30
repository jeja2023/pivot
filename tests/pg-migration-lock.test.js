const test = require('node:test');
const assert = require('node:assert/strict');
const { getPgPool } = require('../server/db/pg-connection');
const { runMigrationsPg } = require('../server/db/migrate');
const { withPgInitializationLock } = require('../server/db/initialization-lock');
const { Pool } = require('pg');

test('并发迁移在同一 schema 串行执行，已登记的迁移只运行一次', { skip: !process.env.DATABASE_URL }, async () => {
    const id = `test_lock_${process.pid}_${Date.now()}`;
    let executions = 0;
    const migration = { id, async upPg(client) { executions += 1; await client.query('SELECT pg_sleep(0.15)'); } };
    const pool = getPgPool();
    try {
        const results = await Promise.all([
            runMigrationsPg({ pool, migrations: [migration] }),
            runMigrationsPg({ pool, migrations: [migration] })
        ]);
        assert.equal(executions, 1);
        assert.equal(results.flat().filter(value => value === id).length, 1);
    } finally {
        await pool.query('DELETE FROM schema_migrations WHERE id = $1', [id]);
    }
});

test('表结构与种子初始化在同一 schema 跨连接串行，异常后可再次进入', { skip: !process.env.DATABASE_URL }, async () => {
    let active = 0;
    let maximum = 0;
    const operation = async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 80));
        active -= 1;
    };
    await Promise.all([withPgInitializationLock(operation), withPgInitializationLock(operation)]);
    assert.equal(maximum, 1);
    await assert.rejects(withPgInitializationLock(async () => { throw new Error('初始化失败'); }), /初始化失败/);
    await withPgInitializationLock(operation);
    assert.equal(active, 0);
    const singleConnectionPool = new Pool({ ...getPgPool().options, max: 1 });
    try {
        await withPgInitializationLock(() => singleConnectionPool.query('SELECT 1'), { pool: singleConnectionPool });
    } finally {
        await singleConnectionPool.end();
    }
});
