const test = require('node:test');
const assert = require('node:assert/strict');
const {
    PG_SCHEMA_VERSION,
    getPgSchemaName,
    isPgSchemaCurrent
} = require('../server/db/schema/pg');

async function withEnv(name, value, run) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try { return await run(); } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
    }
}

test('隔离 PostgreSQL schema 不会误用 public 的 schema 版本标记', async () => {
    await withEnv('PIVOT_PG_SCHEMA_RECONCILE', undefined, () => withEnv('PG_TEST_SCHEMA', 'pivot_isolated_test', async () => {
        const calls = [];
        const pool = {
            async query(sql, params) {
                calls.push({ sql, params });
                return { rows: [{ value: PG_SCHEMA_VERSION }] };
            }
        };
        assert.equal(getPgSchemaName(), 'pivot_isolated_test');
        assert.equal(await isPgSchemaCurrent(pool), true);
        assert.equal(calls.length, 1);
        assert.match(calls[0].sql, /"pivot_isolated_test"\."app_meta"/);
    }));
});

test('隔离 schema 缺少 app_meta 时必须执行初始化，不能回退 public', async () => {
    await withEnv('PIVOT_PG_SCHEMA_RECONCILE', undefined, () => withEnv('PG_TEST_SCHEMA', 'pivot_new_test', async () => {
        const calls = [];
        const pool = {
            async query(sql, params) {
                calls.push({ sql, params });
                const error = new Error('目标关系不存在');
                error.code = '42P01';
                throw error;
            }
        };
        assert.equal(await isPgSchemaCurrent(pool), false);
        assert.equal(calls.length, 1);
        assert.match(calls[0].sql, /"pivot_new_test"\."app_meta"/);
    }));
});

test('PostgreSQL 扩展必须显式声明在 public schema 下并包含异构回迁保护', () => {
    const { buildPgSchemaStatements } = require('../server/db/schema/pg');
    const plan = buildPgSchemaStatements();
    assert.ok(plan.extensions.some(sql => sql.includes('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public')), 'vector 扩展必须指定 SCHEMA public');
    assert.ok(plan.extensions.some(sql => sql.includes('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public')), 'pg_trgm 扩展必须指定 SCHEMA public');
    assert.ok(plan.extensions.some(sql => sql.includes('ALTER EXTENSION vector SET SCHEMA public')), '必须包含 vector 扩展回迁 public 逻辑');
});
