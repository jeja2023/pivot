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
        assert.ok(results.some(result => result.created));
        const state = await pool.query("SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname='idx_memories_embedding_hnsw_197'");
        assert.equal(state.rows[0].indisvalid, true);
        assert.equal((await indexPool.query('SHOW statement_timeout')).rows[0].statement_timeout, beforeTimeout);
    } finally {
        await indexPool.end();
        await pool.query('DROP INDEX CONCURRENTLY IF EXISTS idx_memories_embedding_hnsw_197');
        await pool.query('DELETE FROM memories WHERE content = $1', [marker]);
    }
});
