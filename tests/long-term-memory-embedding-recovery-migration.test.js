const assert = require('node:assert/strict');
const test = require('node:test');

const [migration] = require('../server/db/migrations/long-term-memory-embedding-recovery');

test('长期记忆向量维度迁移兼容 TEXT 与 pgvector 表示', async () => {
    const calls = [];
    await migration.upPg({
        query: async sql => {
            calls.push(String(sql));
            return { rows: [] };
        }
    });

    const sql = calls.join('\n');
    assert.match(sql, /pivot_memory_embedding_dimensions\(input TEXT\)/);
    assert.match(sql, /parsed := input::jsonb/);
    assert.match(sql, /jsonb_typeof\(parsed\) <> 'array'/);
    assert.match(sql, /jsonb_array_elements\(parsed\)/);
    assert.match(sql, /embedding::text/);
    assert.doesNotMatch(sql, /vector_dims\(embedding\)/);
    assert.match(sql, /DROP FUNCTION IF EXISTS pg_temp\.pivot_memory_embedding_dimensions\(TEXT\)/);
});

test('长期记忆向量维度迁移安全处理历史 TEXT 向量', {
    skip: process.env.PIVOT_TEST_PG_SYNC !== 'true'
}, async () => {
    const { getPgPool } = require('../server/db/pg-connection');
    const pool = getPgPool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const user = await client.query('SELECT id FROM users ORDER BY id LIMIT 1');
        assert.ok(user.rows[0]?.id, 'PostgreSQL 测试库必须具备种子用户');
        await client.query('ALTER TABLE memories ALTER COLUMN embedding TYPE TEXT USING embedding::text;');
        const inserted = await client.query(`
            INSERT INTO memories (user_id, type, content, embedding, embedding_dimensions, created_at, updated_at)
            VALUES ($1, 'fact', '迁移兼容性有效向量', '[1,2,3]', 0, NOW(), NOW()),
                   ($1, 'fact', '迁移兼容性非法向量', 'legacy embedding is not JSON', 0, NOW(), NOW()),
                   ($1, 'fact', '迁移兼容性非数组向量', '{}', 0, NOW(), NOW())
            RETURNING id, content
        `, [user.rows[0].id]);

        await migration.upPg(client);

        const dimensions = await client.query(`
            SELECT content, embedding_dimensions
            FROM memories
            WHERE id = ANY($1::bigint[])
            ORDER BY content ASC
        `, [inserted.rows.map(row => Number(row.id))]);
        assert.deepEqual(dimensions.rows.map(row => ({
            content: row.content,
            dimensions: Number(row.embedding_dimensions)
        })), [
            { content: '迁移兼容性有效向量', dimensions: 3 },
            { content: '迁移兼容性非数组向量', dimensions: 0 },
            { content: '迁移兼容性非法向量', dimensions: 0 }
        ]);
    } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
    }
});
