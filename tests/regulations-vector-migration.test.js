const assert = require('node:assert/strict');
const test = require('node:test');

const enabled = process.env.PIVOT_TEST_PG_SYNC === 'true';

test('法规旧 text 向量列迁移不会重写列或既有 ANN 索引，并会重排当前版本索引', { skip: !enabled }, async () => {
    const { getPgPool } = require('../server/db/pg-connection');
    const migration = require('../server/db/migrations/regulations-vector-column-compatibility')[0];
    const pool = getPgPool();
    const client = await pool.connect();
    const title = `法规向量迁移测试-${process.pid}-${Date.now()}`;
    try {
        await client.query('BEGIN');
        const document = await client.query(`
            INSERT INTO regulation_documents (title, status, created_by_user, updated_by_user)
            VALUES ($1, 'active', 1, 1)
            RETURNING id
        `, [title]);
        const documentId = document.rows[0].id;
        const version = await client.query(`
            INSERT INTO regulation_versions (
                document_id, version_label, source_name, source_path, source_format,
                extracted_text, article_count, effect_status, review_status, parse_status,
                index_status, index_attempts, index_max_attempts
            ) VALUES ($1, 'v1', 'migration.txt', 'uploads/migration.txt', 'txt', '第一条 测试正文。', 1, 'effective', 'approved', 'ready', 'vector_ready', 0, 5)
            RETURNING id
        `, [documentId]);
        const versionId = version.rows[0].id;
        await client.query('UPDATE regulation_documents SET current_version_id = $1, version_count = 1, article_count = 1 WHERE id = $2', [versionId, documentId]);
        await client.query(`
            INSERT INTO regulation_articles (document_id, version_id, sort_order, article_label, content, embedding, embedding_profile)
            VALUES ($1, $2, 1, '第一条', '第一条 测试正文。', '[0.1,0.2]'::vector, 'http:old-model')
        `, [documentId, versionId]);
        await client.query('ALTER TABLE regulation_articles ALTER COLUMN embedding TYPE TEXT USING embedding::text');
        const indexName = `idx_regulation_vector_legacy_${process.pid}_${Date.now()}`;
        await client.query(`
            CREATE INDEX ${indexName}
            ON regulation_articles USING hnsw ((embedding::vector(2)) vector_cosine_ops)
            WHERE embedding IS NOT NULL
        `);

        await migration.upPg(client);

        const type = await client.query(`
            SELECT format_type(attribute.atttypid, attribute.atttypmod) AS type
            FROM pg_attribute attribute
            WHERE attribute.attrelid = 'regulation_articles'::regclass
              AND attribute.attname = 'embedding'
        `);
        assert.equal(type.rows[0].type, 'text');
        const state = await client.query(`
            SELECT v.index_status, v.index_attempts, v.embedding_profile AS version_embedding_profile, a.embedding, a.embedding_profile
            FROM regulation_versions v
            JOIN regulation_articles a ON a.version_id = v.id
            WHERE v.id = $1
        `, [versionId]);
        assert.equal(state.rows[0].index_status, 'retry_wait');
        assert.equal(Number(state.rows[0].index_attempts), 0);
        assert.equal(state.rows[0].version_embedding_profile, '');
        // 启动迁移刻意不阻塞同步更新 regulation_articles，避免全表长事务锁表；
        // 条文旧向量保留原样，由后台巡检在 retry_wait 状态下异步覆盖重建
        assert.equal(state.rows[0].embedding, '[0.1,0.2]');
        assert.equal(state.rows[0].embedding_profile, 'http:old-model');
        const index = await client.query('SELECT indexname FROM pg_indexes WHERE indexname = $1', [indexName]);
        assert.equal(index.rows.length, 1, '旧 ANN 表达式索引应被保留，迁移不得触发重建');
    } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
    }
});
