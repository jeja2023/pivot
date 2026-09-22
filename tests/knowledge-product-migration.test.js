'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const migrations = require('../server/db/migrations');
const { getPgPool } = require('../server/db/pg-connection');

test('知识产品化迁移可在缺失所有新表的旧 PostgreSQL 库上安全补齐', async () => {
    const migration = migrations.find(item => item.id === '202609200004_knowledge_product_foundation');
    assert.ok(migration && typeof migration.upPg === 'function');
    const client = await getPgPool().connect();
    try {
        await client.query('BEGIN');
        // 模拟旧库：保留 knowledge_docs / knowledge_chunks 等 RAG 核心表，删除
        // 这次改造引入的产品化表。事务回滚，不污染测试 schema。
        await client.query(`
            DROP TABLE IF EXISTS knowledge_citation_events CASCADE;
            DROP TABLE IF EXISTS knowledge_comments CASCADE;
            DROP TABLE IF EXISTS knowledge_eval_results CASCADE;
            DROP TABLE IF EXISTS knowledge_eval_runs CASCADE;
            DROP TABLE IF EXISTS knowledge_eval_cases CASCADE;
            DROP TABLE IF EXISTS knowledge_reviews CASCADE;
            DROP TABLE IF EXISTS knowledge_citations CASCADE;
            DROP TABLE IF EXISTS knowledge_ingestion_jobs CASCADE;
            DROP TABLE IF EXISTS knowledge_permissions CASCADE;
            DROP TABLE IF EXISTS knowledge_blocks CASCADE;
            DROP TABLE IF EXISTS knowledge_document_versions CASCADE;
            DROP TABLE IF EXISTS knowledge_documents CASCADE;
            DROP TABLE IF EXISTS knowledge_source_sync_runs CASCADE;
            DROP TABLE IF EXISTS knowledge_sources CASCADE;
        `);
        await migration.upPg(client);
        const tables = await client.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = current_schema()
              AND table_name IN (
                'knowledge_sources', 'knowledge_source_sync_runs', 'knowledge_documents',
                'knowledge_document_versions', 'knowledge_blocks', 'knowledge_permissions',
                'knowledge_ingestion_jobs', 'knowledge_citations', 'knowledge_citation_events',
                'knowledge_reviews', 'knowledge_comments', 'knowledge_eval_cases',
                'knowledge_eval_runs', 'knowledge_eval_results'
              )
        `);
        assert.equal(tables.rows.length, 14);
        const columns = await client.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'knowledge_documents'
        `);
        const names = new Set(columns.rows.map(row => row.column_name));
        ['legacy_doc_id', 'current_version_id', 'content_owner_unit', 'freshness_policy', 'review_due_at'].forEach(column => assert.ok(names.has(column), `missing ${column}`));
        const constraints = await client.query(`
            SELECT conname FROM pg_constraint
            WHERE conname IN ('knowledge_documents_current_version_fk', 'knowledge_chunks_block_fk', 'knowledge_docs_source_fk')
        `);
        assert.equal(constraints.rows.length, 3);
        await client.query('ROLLBACK');
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
});

test('知识产品化迁移可安全处理历史遗留 TEXT 类型 embedding 列', async () => {
    const migration = migrations.find(item => item.id === '202609200004_knowledge_product_foundation');
    assert.ok(migration && typeof migration.upPg === 'function');
    const client = await getPgPool().connect();
    try {
        await client.query('BEGIN');
        // 模拟历史库：将 embedding 临时转换为 TEXT 类型，存入 JSON 数组格式的向量字符串
        await client.query(`
            ALTER TABLE knowledge_chunks ALTER COLUMN embedding TYPE TEXT USING embedding::text;
            UPDATE knowledge_chunks SET embedding_dimensions = 0, embedding_profile = '' WHERE embedding IS NOT NULL;
        `);
        // 执行迁移，应当自动适配 TEXT 类型，不触发 vector_dims(text) 错误，亦不发生锁表超时
        await migration.upPg(client);

        // 验证 embedding_dimensions 与 embedding_profile 已被正确计算
        const res = await client.query(`
            SELECT embedding_dimensions, embedding_profile
            FROM knowledge_chunks
            WHERE embedding IS NOT NULL AND trim(embedding::text) ~ '^\s*\\['
            LIMIT 1
        `);
        if (res.rows.length > 0) {
            assert.ok(Number(res.rows[0].embedding_dimensions) > 0);
            assert.ok(String(res.rows[0].embedding_profile).startsWith('legacy:'));
        }

        await client.query('ROLLBACK');
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
});

