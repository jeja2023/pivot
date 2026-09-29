const assert = require('node:assert/strict');
const test = require('node:test');

const [migration] = require('../server/db/migrations/memory-source-ids-jsonb-compatibility');
const fs = require('node:fs');
const path = require('node:path');

test('记忆来源 JSONB 兼容迁移跳过已规范化的列', async () => {
    const calls = [];
    await migration.upPg({
        query: async (sql, params = []) => {
            calls.push({ sql: String(sql), params });
            return { rows: [{ data_type: 'jsonb' }] };
        }
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.params), [['memories', 'source_message_ids'], ['memory_suppressions', 'source_message_ids']]);
});

test('记忆来源 JSONB 兼容迁移把历史 TEXT 数组转换为可写的 JSONB 列', async () => {
    const calls = [];
    await migration.upPg({
        query: async (sql, params = []) => {
            calls.push({ sql: String(sql), params });
            return calls.length <= 2 ? { rows: [{ data_type: 'text' }] } : { rows: [] };
        }
    });
    const sql = calls.map(call => call.sql).join('\n');
    assert.match(sql, /pivot_memory_source_ids_to_jsonb\(input TEXT\)/);
    assert.match(sql, /ALTER TABLE memories\s+ALTER COLUMN source_message_ids TYPE JSONB/);
    assert.match(sql, /ALTER TABLE memory_suppressions\s+ALTER COLUMN source_message_ids TYPE JSONB/);
    assert.match(sql, /SET DEFAULT '\[\]'::jsonb/);
    assert.match(sql, /memory_suppressions ALTER COLUMN source_message_ids SET NOT NULL/);
    assert.match(sql, /DROP FUNCTION IF EXISTS pg_temp\.pivot_memory_source_ids_to_jsonb\(TEXT\)/);
});

test('来源撤销写入同时兼容迁移前 TEXT 列与迁移后 JSONB 列', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../server/services/long-term-memory/memory-sources.js'), 'utf8');
    assert.match(source, /source_message_ids = \?, updated_at = \?/);
    assert.doesNotMatch(source, /source_message_ids\s*=\s*'\[\]'::jsonb/);
    assert.doesNotMatch(source, /source_message_ids\s*=\s*\?::jsonb/);
});

test('记忆来源 JSONB 兼容迁移可在 PostgreSQL 中修复删除路径涉及的两张历史 TEXT 表', {
    skip: process.env.PIVOT_TEST_PG_SYNC !== 'true'
}, async () => {
    const { getPgPool } = require('../server/db/pg-connection');
    const client = await getPgPool().connect();
    const suffix = `${process.pid}${Date.now()}`.slice(-12);
    try {
        await client.query('BEGIN');
        const user = await client.query('SELECT id FROM users ORDER BY id LIMIT 1');
        assert.ok(user.rows[0]?.id, 'PostgreSQL 测试库必须具备种子用户');
        await client.query('ALTER TABLE memories ALTER COLUMN source_message_ids DROP DEFAULT;');
        await client.query('ALTER TABLE memories ALTER COLUMN source_message_ids TYPE TEXT USING source_message_ids::text;');
        await client.query('ALTER TABLE memory_suppressions ALTER COLUMN source_message_ids DROP DEFAULT;');
        await client.query('ALTER TABLE memory_suppressions ALTER COLUMN source_message_ids DROP NOT NULL;');
        await client.query('ALTER TABLE memory_suppressions ALTER COLUMN source_message_ids TYPE TEXT USING source_message_ids::text;');
        const memory = await client.query(`
            INSERT INTO memories (user_id, type, content, source_message_ids, created_at, updated_at)
            VALUES ($1, 'fact', '来源 JSONB 迁移验证', $2, NOW(), NOW())
            RETURNING id
        `, [user.rows[0].id, '[101,102]']);
        await client.query(`
            INSERT INTO memory_suppressions (user_id, fingerprint, source_message_ids, reason, created_at)
            VALUES ($1, $2, $3, 'test', NOW())
        `, [user.rows[0].id, `memory-source-jsonb-${suffix}`, '[103]']);

        await migration.upPg(client);

        const values = await client.query(`
            SELECT
                (SELECT pg_typeof(source_message_ids)::text FROM memories WHERE id = $1) AS memory_type,
                (SELECT source_message_ids FROM memories WHERE id = $1) AS memory_ids,
                (SELECT pg_typeof(source_message_ids)::text FROM memory_suppressions WHERE fingerprint = $2) AS suppression_type,
                (SELECT source_message_ids FROM memory_suppressions WHERE fingerprint = $2) AS suppression_ids
        `, [memory.rows[0].id, `memory-source-jsonb-${suffix}`]);
        assert.equal(values.rows[0].memory_type, 'jsonb');
        assert.equal(values.rows[0].suppression_type, 'jsonb');
        assert.deepEqual(values.rows[0].memory_ids, [101, 102]);
        assert.deepEqual(values.rows[0].suppression_ids, [103]);
    } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
    }
});
