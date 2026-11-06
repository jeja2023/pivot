const test = require('node:test');
const assert = require('node:assert/strict');
const { getPgPool } = require('../server/db/pg-connection');
const { Pool } = require('pg');
const { ensureMemoryVectorIndex } = require('../server/services/long-term-memory/memory-vector-index');

test('长期记忆 HNSW 并发构建可恢复失败的无效索引', { skip: !process.env.DATABASE_URL }, async () => {
    const pool = getPgPool();
    const user = (await pool.query('SELECT id FROM users ORDER BY id LIMIT 1')).rows[0];
    const marker = `hnsw-test-${process.pid}-${Date.now()}`;
    const vector = JSON.stringify(Array(197).fill(0.1));
    const indexPool = new Pool({ ...pool.options, max: 1 });
    try {
        const beforeTimeout = (await indexPool.query('SHOW statement_timeout')).rows[0].statement_timeout;
        await pool.query("INSERT INTO memories (user_id,type,content,embedding,embedding_dimensions,status) VALUES ($1,'fact',$2,$3::vector,197,'active'),($1,'fact',$2,$3::vector,197,'active')", [user.id, marker, vector]);
        await assert.rejects(pool.query('CREATE UNIQUE INDEX CONCURRENTLY idx_memories_embedding_hnsw_197 ON memories (content)'));
        const results = await Promise.all([ensureMemoryVectorIndex(197, { minRows: 1, pool: indexPool }), ensureMemoryVectorIndex(197, { minRows: 1 })]);
        assert.ok(results.some(result => result.created), `无效索引应可恢复：${JSON.stringify(results)}`);
        const state = await pool.query("SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname='idx_memories_embedding_hnsw_197'");
        assert.equal(state.rows[0].indisvalid, true);
        assert.equal((await indexPool.query('SHOW statement_timeout')).rows[0].statement_timeout, beforeTimeout);
    } finally {
        await indexPool.end();
        await pool.query('DROP INDEX CONCURRENTLY IF EXISTS idx_memories_embedding_hnsw_197');
        await pool.query('DELETE FROM memories WHERE content = $1', [marker]);
    }
});

test('无效索引正在使用、属于其它表或缺少管理权限时均不得删除，并恢复连接超时', async () => {
    for (const [state, expected] of [
        [{ owns_index: true, table_name: 'memories', index_in_use: true }, 'build_in_progress'],
        [{ owns_index: true, table_name: 'other_table' }, 'index_definition_conflict'],
        [{ owns_index: false, table_name: 'memories', can_inspect_builders: false }, 'invalid_index_requires_admin']
    ]) {
        const statements = [];
        let released = false;
        const client = { query: async (sql, params) => {
            statements.push({ sql, params });
            if (sql.includes("current_setting('statement_timeout')")) return { rows: [{ timeout: '20s' }] };
            if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
            if (sql.includes('FROM pg_class')) return { rows: [{ schema_name: 'synthetic_schema', valid: false, ...state }] };
            return { rows: [] };
        }, release() { released = true; } };
        const result = await ensureMemoryVectorIndex(197, { minRows: 1, queryOne: async () => ({ count: 2 }), pool: { connect: async () => client } });
        assert.equal(result.reason, expected);
        assert.equal(statements.some(item => /DROP INDEX|CREATE INDEX/.test(item.sql)), false);
        assert.ok(statements.some(item => item.sql.includes('set_config') && item.params[0] === '20s'));
        assert.equal(released, true);
    }
});
