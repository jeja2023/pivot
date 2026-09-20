'use strict';

// 基础产品化迁移第一次发布后，治理能力仍会持续演进。此迁移刻意全部写成
// 幂等 DDL，以支持已应用 foundation 的生产库安全升级，也支持新库重复执行。
const migration = {
    id: '202609200005_knowledge_product_governance',
    description: 'Converge knowledge governance, citation analytics and source sync history on existing product foundations.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE IF EXISTS knowledge_documents ADD COLUMN IF NOT EXISTS content_owner_unit TEXT NOT NULL DEFAULT '';
            ALTER TABLE IF EXISTS knowledge_documents ADD COLUMN IF NOT EXISTS freshness_policy TEXT NOT NULL DEFAULT 'manual';
            ALTER TABLE IF EXISTS knowledge_document_versions ADD COLUMN IF NOT EXISTS legacy_doc_id BIGINT;
            CREATE TABLE IF NOT EXISTS knowledge_source_sync_runs (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                source_id BIGINT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
                initiated_by_user BIGINT REFERENCES users(id) ON DELETE SET NULL,
                trigger_type TEXT NOT NULL DEFAULT 'manual',
                status TEXT NOT NULL DEFAULT 'running',
                summary_json TEXT NOT NULL DEFAULT '{}',
                error_message TEXT NOT NULL DEFAULT '',
                started_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                completed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE TABLE IF NOT EXISTS knowledge_citation_events (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                citation_id BIGINT NOT NULL REFERENCES knowledge_citations(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                event_type TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE TABLE IF NOT EXISTS knowledge_comments (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                document_id BIGINT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
                version_id BIGINT REFERENCES knowledge_document_versions(id) ON DELETE SET NULL,
                block_id BIGINT REFERENCES knowledge_blocks(id) ON DELETE SET NULL,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                kind TEXT NOT NULL DEFAULT 'comment',
                status TEXT NOT NULL DEFAULT 'open',
                content TEXT NOT NULL,
                resolved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                resolved_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_knowledge_source_sync_runs_source ON knowledge_source_sync_runs(source_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_source_sync_runs_status ON knowledge_source_sync_runs(status, started_at ASC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_documents_review_due ON knowledge_documents(lifecycle_status, review_due_at, verified_status);
            CREATE INDEX IF NOT EXISTS idx_knowledge_versions_legacy_doc ON knowledge_document_versions(legacy_doc_id);
            CREATE INDEX IF NOT EXISTS idx_knowledge_citation_events_citation ON knowledge_citation_events(citation_id, event_type, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_citation_events_user ON knowledge_citation_events(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_comments_document ON knowledge_comments(document_id, status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_comments_block ON knowledge_comments(block_id, status, created_at DESC);
        `);
    }
};

module.exports = [migration];
