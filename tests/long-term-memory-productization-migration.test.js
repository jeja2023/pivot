const assert = require('node:assert/strict');
const test = require('node:test');

const [migration] = require('../server/db/migrations/long-term-memory-productization');

test('长期记忆迁移兼容 TEXT 与 JSONB 来源消息列表', async () => {
    const calls = [];
    await migration.upPg({
        query: async sql => {
            calls.push(String(sql));
            return { rows: [] };
        }
    });

    const sql = calls.join('\n');
    assert.match(sql, /pivot_memory_source_ids_to_jsonb\(input TEXT\)/);
    assert.match(sql, /parsed := input::jsonb/);
    assert.match(sql, /jsonb_typeof\(parsed\) <> 'array'/);
    assert.match(sql, /EXCEPTION WHEN others THEN/);
    assert.match(sql, /pivot_memory_source_ids_to_jsonb\(m\.source_message_ids::text\)/);
    assert.doesNotMatch(sql, /COALESCE\(m\.source_message_ids,\s*'\[\]'::jsonb\)/);
    assert.match(sql, /DROP FUNCTION IF EXISTS pg_temp\.pivot_memory_source_ids_to_jsonb\(TEXT\)/);
});

test('长期记忆迁移可回填 TEXT 来源消息列表', {
    skip: process.env.PIVOT_TEST_PG_SYNC !== 'true'
}, async () => {
    const { getPgPool } = require('../server/db/pg-connection');
    const pool = getPgPool();
    const client = await pool.connect();
    const suffix = `${process.pid}${Date.now()}`.slice(-12);
    const messageId = Number(`8${suffix}`);
    try {
        await client.query('BEGIN');
        const user = await client.query('SELECT id FROM users ORDER BY id LIMIT 1');
        assert.ok(user.rows[0]?.id, 'PostgreSQL 测试库必须具备种子用户');
        await client.query('ALTER TABLE memories ALTER COLUMN source_message_ids DROP DEFAULT;');
        await client.query('ALTER TABLE memories ALTER COLUMN source_message_ids TYPE TEXT USING source_message_ids::text;');
        const inserted = await client.query(`
            INSERT INTO memories (user_id, type, content, source_message_ids, created_at, updated_at)
            VALUES ($1, 'fact', '迁移兼容性有效数组', $2, NOW(), NOW()),
                   ($1, 'fact', '迁移兼容性非法文本', $3, NOW(), NOW()),
                   ($1, 'fact', '迁移兼容性非数组', $4, NOW(), NOW())
            RETURNING id, content
        `, [user.rows[0].id, JSON.stringify([messageId]), 'legacy value is not JSON', '{}']);
        const validMemory = inserted.rows.find(row => row.content === '迁移兼容性有效数组');
        assert.ok(validMemory?.id);

        await migration.upPg(client);

        const evidence = await client.query(`
            SELECT memory_id, message_id
            FROM memory_source_evidence
            WHERE memory_id = ANY($1::bigint[])
            ORDER BY memory_id ASC
        `, [inserted.rows.map(row => Number(row.id))]);
        assert.deepEqual(evidence.rows.map(row => ({
            memoryId: Number(row.memory_id),
            messageId: Number(row.message_id)
        })), [{
            memoryId: Number(validMemory.id),
            messageId
        }]);
    } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
    }
});
