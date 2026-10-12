'use strict';

// 法规库第二阶段基础：管理状态、法律效力、来源审核和删除状态分开保存，
// 并为条文原页定位、引用版本绑定和可恢复导入任务提供持久化边界。
module.exports = [{
    id: '202610120003_regulations_governance_foundation',
    description: 'Add regulation governance metadata, source locations and recoverable import jobs.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE regulation_documents ADD COLUMN IF NOT EXISTS legal_level TEXT NOT NULL DEFAULT '';
            ALTER TABLE regulation_documents ADD COLUMN IF NOT EXISTS official_source_url TEXT NOT NULL DEFAULT '';
            ALTER TABLE regulation_documents ADD COLUMN IF NOT EXISTS subject_tags JSONB NOT NULL DEFAULT '[]'::jsonb;
            ALTER TABLE regulation_documents ADD COLUMN IF NOT EXISTS metadata_review_status TEXT NOT NULL DEFAULT 'unreviewed';
            ALTER TABLE regulation_documents ADD COLUMN IF NOT EXISTS metadata_reviewed_by_user BIGINT;
            ALTER TABLE regulation_documents ADD COLUMN IF NOT EXISTS metadata_reviewed_at TIMESTAMPTZ;
            ALTER TABLE regulation_documents ADD COLUMN IF NOT EXISTS maintainer_user_id BIGINT;

            ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS source_url TEXT NOT NULL DEFAULT '';
            ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS published_at DATE;
            ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS effective_from DATE;
            ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS effective_to DATE;
            ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS effect_status TEXT NOT NULL DEFAULT 'unverified';
            ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending';
            ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS reviewed_by_user BIGINT;
            ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
            ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS parse_status TEXT NOT NULL DEFAULT 'ready';
            ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS index_status TEXT NOT NULL DEFAULT 'lexical_ready';
            ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS index_error TEXT NOT NULL DEFAULT '';
            ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS embedding_profile TEXT NOT NULL DEFAULT '';

            ALTER TABLE regulation_articles ADD COLUMN IF NOT EXISTS stable_key TEXT NOT NULL DEFAULT '';
            ALTER TABLE regulation_articles ADD COLUMN IF NOT EXISTS logical_path TEXT NOT NULL DEFAULT '';
            ALTER TABLE regulation_articles ADD COLUMN IF NOT EXISTS page_start BIGINT;
            ALTER TABLE regulation_articles ADD COLUMN IF NOT EXISTS page_end BIGINT;
            ALTER TABLE regulation_articles ADD COLUMN IF NOT EXISTS embedding_profile TEXT NOT NULL DEFAULT '';

            ALTER TABLE regulation_article_links ADD COLUMN IF NOT EXISTS target_version_id BIGINT;
            ALTER TABLE regulation_article_links ADD COLUMN IF NOT EXISTS binding_mode TEXT NOT NULL DEFAULT 'current';
            ALTER TABLE regulation_article_links ADD COLUMN IF NOT EXISTS evidence_excerpt TEXT NOT NULL DEFAULT '';
            ALTER TABLE regulation_article_links ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'auto';

            CREATE TABLE IF NOT EXISTS regulation_article_locations (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                article_id BIGINT NOT NULL REFERENCES regulation_articles(id) ON DELETE CASCADE,
                page_number BIGINT NOT NULL,
                char_start BIGINT,
                char_end BIGINT,
                block_index BIGINT,
                bbox_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                confidence DOUBLE PRECISION,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );

            CREATE TABLE IF NOT EXISTS regulation_import_jobs (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                document_id BIGINT REFERENCES regulation_documents(id) ON DELETE SET NULL,
                version_id BIGINT REFERENCES regulation_versions(id) ON DELETE SET NULL,
                source_name TEXT NOT NULL DEFAULT '',
                source_path TEXT NOT NULL DEFAULT '',
                source_hash TEXT NOT NULL DEFAULT '',
                mode TEXT NOT NULL DEFAULT 'create',
                status TEXT NOT NULL DEFAULT 'queued',
                stage TEXT NOT NULL DEFAULT 'queued',
                progress BIGINT NOT NULL DEFAULT 0,
                attempts BIGINT NOT NULL DEFAULT 0,
                max_attempts BIGINT NOT NULL DEFAULT 3,
                locked_by TEXT NOT NULL DEFAULT '',
                locked_at TIMESTAMPTZ,
                next_retry_at TIMESTAMPTZ,
                payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                error_code TEXT NOT NULL DEFAULT '',
                error_message TEXT NOT NULL DEFAULT '',
                completed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );

            CREATE TABLE IF NOT EXISTS regulation_subscriptions (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                document_id BIGINT NOT NULL REFERENCES regulation_documents(id) ON DELETE CASCADE,
                status TEXT NOT NULL DEFAULT 'active',
                approved_only BOOLEAN NOT NULL DEFAULT TRUE,
                last_notified_version_id BIGINT REFERENCES regulation_versions(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(user_id, document_id)
            );

            CREATE TABLE IF NOT EXISTS regulation_obligations (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                document_id BIGINT NOT NULL REFERENCES regulation_documents(id) ON DELETE CASCADE,
                version_id BIGINT NOT NULL REFERENCES regulation_versions(id) ON DELETE CASCADE,
                article_id BIGINT NOT NULL REFERENCES regulation_articles(id) ON DELETE CASCADE,
                subject TEXT NOT NULL DEFAULT '',
                trigger_condition TEXT NOT NULL DEFAULT '',
                required_action TEXT NOT NULL DEFAULT '',
                due_rule TEXT NOT NULL DEFAULT '',
                evidence_requirement TEXT NOT NULL DEFAULT '',
                owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                review_status TEXT NOT NULL DEFAULT 'pending',
                created_by_user BIGINT NOT NULL DEFAULT 0,
                reviewed_by_user BIGINT REFERENCES users(id) ON DELETE SET NULL,
                reviewed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );

            CREATE INDEX IF NOT EXISTS idx_regulation_documents_effective
                ON regulation_documents(status, deleted_at, legal_level, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_regulation_versions_effective
                ON regulation_versions(document_id, effect_status, effective_from, effective_to);
            CREATE INDEX IF NOT EXISTS idx_regulation_articles_stable_key
                ON regulation_articles(document_id, stable_key, version_id);
            CREATE INDEX IF NOT EXISTS idx_regulation_article_links_target_version
                ON regulation_article_links(target_document_id, target_version_id, target_article_id);
            CREATE INDEX IF NOT EXISTS idx_regulation_article_locations_article
                ON regulation_article_locations(article_id, page_number, block_index);
            CREATE INDEX IF NOT EXISTS idx_regulation_import_jobs_pending
                ON regulation_import_jobs(status, next_retry_at, created_at);
            CREATE INDEX IF NOT EXISTS idx_regulation_import_jobs_document
                ON regulation_import_jobs(document_id, version_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_regulation_subscriptions_document
                ON regulation_subscriptions(document_id, status, user_id);
            CREATE INDEX IF NOT EXISTS idx_regulation_obligations_article
                ON regulation_obligations(article_id, status, review_status);
        `);
    }
}];
