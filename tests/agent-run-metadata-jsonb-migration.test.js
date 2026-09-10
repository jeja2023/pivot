const assert = require('node:assert/strict');
const test = require('node:test');

const [migration] = require('../server/db/migrations/agent-run-metadata-jsonb-compatibility');

test('Agent 运行元数据 JSONB 兼容迁移跳过已规范化的 PostgreSQL 列', async () => {
    const calls = [];
    await migration.upPg({
        query: async sql => {
            calls.push(String(sql));
            return { rows: [{ data_type: 'jsonb' }] };
        }
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /a\.atttypid::regtype::text AS data_type/);
});

test('Agent 运行元数据 JSONB 兼容迁移无损转换历史 TEXT 列', async () => {
    const calls = [];
    await migration.upPg({
        query: async sql => {
            calls.push(String(sql));
            return calls.length === 1 ? { rows: [{ data_type: 'text' }] } : { rows: [] };
        }
    });
    const sql = calls.join('\n');
    assert.match(sql, /pivot_agent_metadata_to_jsonb/);
    assert.match(sql, /RETURN input::jsonb/);
    assert.match(sql, /jsonb_build_object\('_legacyRaw', input\)/);
    assert.match(sql, /ALTER TABLE agent_runs\s+ALTER COLUMN metadata TYPE JSONB/);
    assert.match(sql, /USING pg_temp\.pivot_agent_metadata_to_jsonb\(metadata::text\)/);
    assert.match(sql, /DROP FUNCTION IF EXISTS pg_temp\.pivot_agent_metadata_to_jsonb\(TEXT\)/);
});

test('Agent 运行元数据 JSONB 兼容迁移可在 PostgreSQL 中转换真实历史记录', {
    skip: process.env.PIVOT_TEST_DB_SYNC !== 'postgres'
}, async () => {
    const { getPgPool } = require('../server/db/pg-connection');
    const pool = getPgPool();
    const client = await pool.connect();
    const suffix = `${process.pid}-${Date.now()}`;
    const validId = `metadata-jsonb-valid-${suffix}`;
    const invalidId = `metadata-jsonb-invalid-${suffix}`;
    try {
        const user = await client.query('SELECT id FROM users ORDER BY id LIMIT 1');
        assert.ok(user.rows[0]?.id, 'PostgreSQL 测试库必须具备种子用户');
        await client.query('ALTER TABLE agent_runs ALTER COLUMN metadata TYPE TEXT USING metadata::text;');
        await client.query(`
            INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
            VALUES ($1, $2, 'metadata', 'metadata', 'completed', $3, NOW(), NOW()),
                   ($4, $2, 'metadata', 'metadata', 'completed', $5, NOW(), NOW())
        `, [validId, user.rows[0].id, '{"chatBridge":{"version":1}}', invalidId, 'legacy metadata that is not JSON']);

        await migration.upPg(client);

        const rows = await client.query(`
            SELECT id, pg_typeof(metadata)::text AS metadata_type, metadata
            FROM agent_runs
            WHERE id = ANY($1::text[])
            ORDER BY id ASC
        `, [[invalidId, validId]]);
        assert.deepEqual(rows.rows.map(row => row.metadata_type), ['jsonb', 'jsonb']);
        const invalid = rows.rows.find(row => row.id === invalidId);
        const valid = rows.rows.find(row => row.id === validId);
        assert.equal(invalid.metadata._legacyRaw, 'legacy metadata that is not JSON');
        assert.equal(valid.metadata.chatBridge.version, 1);
    } finally {
        client.release();
    }
});
