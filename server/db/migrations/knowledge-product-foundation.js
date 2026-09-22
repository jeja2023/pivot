'use strict';

const migration = {
    id: '202609200004_knowledge_product_foundation',
    description: 'Add durable knowledge sources, versions, jobs, citations, governance and evaluation foundations.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS block_id BIGINT;
            ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_profile TEXT NOT NULL DEFAULT '';
            ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_dimensions BIGINT NOT NULL DEFAULT 0;
            ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS source_id BIGINT;
            ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS product_document_id BIGINT;
            ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'published';
            ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS verified_status TEXT NOT NULL DEFAULT 'unverified';
            ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS content_owner_user_id BIGINT;
            ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS verifier_user_id BIGINT;
            ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
            ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS review_due_at TIMESTAMPTZ;
            ALTER TABLE IF EXISTS knowledge_document_versions ADD COLUMN IF NOT EXISTS legacy_doc_id BIGINT;
            ALTER TABLE IF EXISTS knowledge_documents ADD COLUMN IF NOT EXISTS content_owner_unit TEXT NOT NULL DEFAULT '';
            ALTER TABLE IF EXISTS knowledge_documents ADD COLUMN IF NOT EXISTS freshness_policy TEXT NOT NULL DEFAULT 'manual';

            -- 不在启动事务中扫描或回填历史 knowledge_chunks。生产大库中这类
            -- UPDATE 会超过 statement_timeout，且事务回滚后每次重启都会重做。
            -- 未回填的历史记录保留 embedding_dimensions=0；检索层会安全地将其
            -- 作为有限兼容候选处理。新写入的记录始终携带 profile 与维度。

            CREATE TABLE IF NOT EXISTS knowledge_sources (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                collection_id BIGINT REFERENCES knowledge_collections(id) ON DELETE SET NULL,
                name TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'upload',
                config_json TEXT NOT NULL DEFAULT '{}',
                sync_mode TEXT NOT NULL DEFAULT 'manual',
                sync_cursor TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'active',
                last_sync_at TIMESTAMPTZ,
                last_error TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                deleted_at TIMESTAMPTZ
            );
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
            CREATE TABLE IF NOT EXISTS knowledge_documents (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                legacy_doc_id BIGINT UNIQUE REFERENCES knowledge_docs(id) ON DELETE SET NULL,
                source_id BIGINT REFERENCES knowledge_sources(id) ON DELETE SET NULL,
                collection_id BIGINT REFERENCES knowledge_collections(id) ON DELETE SET NULL,
                owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                canonical_uri TEXT NOT NULL DEFAULT '',
                mime_type TEXT NOT NULL DEFAULT '',
                visibility_status TEXT NOT NULL DEFAULT 'personal',
                lifecycle_status TEXT NOT NULL DEFAULT 'draft',
                current_version_id BIGINT,
                content_owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
                content_owner_unit TEXT NOT NULL DEFAULT '',
                verifier_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
                verified_status TEXT NOT NULL DEFAULT 'unverified',
                verified_at TIMESTAMPTZ,
                review_due_at TIMESTAMPTZ,
                freshness_policy TEXT NOT NULL DEFAULT 'manual',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                deleted_at TIMESTAMPTZ
            );
            CREATE TABLE IF NOT EXISTS knowledge_document_versions (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                document_id BIGINT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
                legacy_doc_id BIGINT REFERENCES knowledge_docs(id) ON DELETE SET NULL,
                version_no BIGINT NOT NULL,
                source_hash TEXT NOT NULL DEFAULT '',
                source_size BIGINT NOT NULL DEFAULT 0,
                source_updated_at TIMESTAMPTZ,
                parser_version TEXT NOT NULL DEFAULT '',
                chunker_version TEXT NOT NULL DEFAULT '',
                embedding_profile TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'draft',
                content_path TEXT NOT NULL DEFAULT '',
                change_summary TEXT NOT NULL DEFAULT '',
                submitted_at TIMESTAMPTZ,
                reviewed_at TIMESTAMPTZ,
                reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                published_at TIMESTAMPTZ,
                published_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(document_id, version_no)
            );
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_documents_current_version_fk') THEN
                    ALTER TABLE knowledge_documents
                        ADD CONSTRAINT knowledge_documents_current_version_fk
                        FOREIGN KEY (current_version_id) REFERENCES knowledge_document_versions(id) ON DELETE SET NULL;
                END IF;
            END $$;
            CREATE TABLE IF NOT EXISTS knowledge_blocks (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                version_id BIGINT NOT NULL REFERENCES knowledge_document_versions(id) ON DELETE CASCADE,
                parent_block_id BIGINT REFERENCES knowledge_blocks(id) ON DELETE SET NULL,
                block_type TEXT NOT NULL DEFAULT 'paragraph',
                block_order BIGINT NOT NULL DEFAULT 0,
                heading_path TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL DEFAULT '',
                page_no BIGINT,
                sheet_name TEXT NOT NULL DEFAULT '',
                slide_no BIGINT,
                char_start BIGINT,
                char_end BIGINT,
                bbox_json TEXT NOT NULL DEFAULT '{}',
                source_locator_json TEXT NOT NULL DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE TABLE IF NOT EXISTS knowledge_permissions (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                resource_type TEXT NOT NULL,
                resource_id BIGINT NOT NULL,
                principal_type TEXT NOT NULL,
                principal_id TEXT NOT NULL,
                permission TEXT NOT NULL DEFAULT 'viewer',
                inherited BIGINT NOT NULL DEFAULT 0,
                expires_at TIMESTAMPTZ,
                created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(resource_type, resource_id, principal_type, principal_id, permission)
            );
            CREATE TABLE IF NOT EXISTS knowledge_ingestion_jobs (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                doc_id BIGINT NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                source_id BIGINT REFERENCES knowledge_sources(id) ON DELETE SET NULL,
                document_id BIGINT REFERENCES knowledge_documents(id) ON DELETE SET NULL,
                version_id BIGINT REFERENCES knowledge_document_versions(id) ON DELETE SET NULL,
                job_type TEXT NOT NULL DEFAULT 'index',
                stage TEXT NOT NULL DEFAULT 'queued',
                status TEXT NOT NULL DEFAULT 'queued',
                priority BIGINT NOT NULL DEFAULT 0,
                attempts BIGINT NOT NULL DEFAULT 0,
                max_attempts BIGINT NOT NULL DEFAULT 5,
                idempotency_key TEXT NOT NULL UNIQUE,
                payload_json TEXT NOT NULL DEFAULT '{}',
                next_retry_at TIMESTAMPTZ,
                locked_by TEXT NOT NULL DEFAULT '',
                locked_at TIMESTAMPTZ,
                error_code TEXT NOT NULL DEFAULT '',
                error_message TEXT NOT NULL DEFAULT '',
                completed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE TABLE IF NOT EXISTS knowledge_citations (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                citation_key TEXT NOT NULL UNIQUE,
                document_id BIGINT REFERENCES knowledge_documents(id) ON DELETE SET NULL,
                version_id BIGINT REFERENCES knowledge_document_versions(id) ON DELETE SET NULL,
                block_id BIGINT REFERENCES knowledge_blocks(id) ON DELETE SET NULL,
                legacy_chunk_id BIGINT REFERENCES knowledge_chunks(id) ON DELETE SET NULL,
                title_snapshot TEXT NOT NULL DEFAULT '',
                locator_json TEXT NOT NULL DEFAULT '{}',
                quoted_text TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE TABLE IF NOT EXISTS knowledge_citation_events (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                citation_id BIGINT NOT NULL REFERENCES knowledge_citations(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                event_type TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE TABLE IF NOT EXISTS knowledge_reviews (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                version_id BIGINT NOT NULL REFERENCES knowledge_document_versions(id) ON DELETE CASCADE,
                reviewer_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                status TEXT NOT NULL DEFAULT 'pending',
                note TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
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
            CREATE TABLE IF NOT EXISTS knowledge_eval_cases (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                collection_id BIGINT REFERENCES knowledge_collections(id) ON DELETE SET NULL,
                name TEXT NOT NULL,
                query TEXT NOT NULL,
                expected_document_ids TEXT NOT NULL DEFAULT '[]',
                expected_chunk_ids TEXT NOT NULL DEFAULT '[]',
                expected_answer_points TEXT NOT NULL DEFAULT '[]',
                expected_citation_keys TEXT NOT NULL DEFAULT '[]',
                difficulty TEXT NOT NULL DEFAULT 'normal',
                status TEXT NOT NULL DEFAULT 'active',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                deleted_at TIMESTAMPTZ
            );
            CREATE TABLE IF NOT EXISTS knowledge_eval_runs (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'queued',
                config_json TEXT NOT NULL DEFAULT '{}',
                summary_json TEXT NOT NULL DEFAULT '{}',
                started_at TIMESTAMPTZ,
                completed_at TIMESTAMPTZ,
                error_message TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE TABLE IF NOT EXISTS knowledge_eval_results (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                run_id BIGINT NOT NULL REFERENCES knowledge_eval_runs(id) ON DELETE CASCADE,
                case_id BIGINT NOT NULL REFERENCES knowledge_eval_cases(id) ON DELETE CASCADE,
                status TEXT NOT NULL DEFAULT 'completed',
                retrieved_document_ids TEXT NOT NULL DEFAULT '[]',
                retrieved_chunk_ids TEXT NOT NULL DEFAULT '[]',
                citation_keys TEXT NOT NULL DEFAULT '[]',
                answer TEXT NOT NULL DEFAULT '',
                metrics_json TEXT NOT NULL DEFAULT '{}',
                error_message TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_knowledge_sources_owner_status ON knowledge_sources(user_id, status, deleted_at, updated_at);
            CREATE INDEX IF NOT EXISTS idx_knowledge_source_sync_runs_source ON knowledge_source_sync_runs(source_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_source_sync_runs_status ON knowledge_source_sync_runs(status, started_at ASC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_documents_owner_status ON knowledge_documents(owner_user_id, lifecycle_status, deleted_at, updated_at);
            CREATE INDEX IF NOT EXISTS idx_knowledge_documents_review_due ON knowledge_documents(lifecycle_status, review_due_at, verified_status);
            CREATE INDEX IF NOT EXISTS idx_knowledge_versions_document ON knowledge_document_versions(document_id, version_no DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_versions_legacy_doc ON knowledge_document_versions(legacy_doc_id);
            CREATE INDEX IF NOT EXISTS idx_knowledge_blocks_version_order ON knowledge_blocks(version_id, block_order, id);
            CREATE INDEX IF NOT EXISTS idx_knowledge_permissions_resource ON knowledge_permissions(resource_type, resource_id, permission);
            CREATE INDEX IF NOT EXISTS idx_knowledge_permissions_principal ON knowledge_permissions(principal_type, principal_id, expires_at);
            CREATE INDEX IF NOT EXISTS idx_knowledge_ingestion_jobs_claim ON knowledge_ingestion_jobs(status, next_retry_at, priority DESC, created_at);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_ingestion_jobs_active_doc
                ON knowledge_ingestion_jobs(doc_id, job_type)
                WHERE status IN ('queued', 'running', 'retry_wait');
            CREATE INDEX IF NOT EXISTS idx_knowledge_citations_legacy_chunk ON knowledge_citations(legacy_chunk_id);
            CREATE INDEX IF NOT EXISTS idx_knowledge_citations_block ON knowledge_citations(block_id);
            CREATE INDEX IF NOT EXISTS idx_knowledge_citation_events_citation ON knowledge_citation_events(citation_id, event_type, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_citation_events_user ON knowledge_citation_events(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_reviews_version ON knowledge_reviews(version_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_comments_document ON knowledge_comments(document_id, status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_comments_block ON knowledge_comments(block_id, status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_eval_cases_owner ON knowledge_eval_cases(user_id, status, deleted_at);
            CREATE INDEX IF NOT EXISTS idx_knowledge_eval_results_run ON knowledge_eval_results(run_id, case_id);
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_chunks_block_fk') THEN
                    ALTER TABLE knowledge_chunks ADD CONSTRAINT knowledge_chunks_block_fk
                        FOREIGN KEY (block_id) REFERENCES knowledge_blocks(id) ON DELETE SET NULL NOT VALID;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_docs_source_fk') THEN
                    ALTER TABLE knowledge_docs ADD CONSTRAINT knowledge_docs_source_fk
                        FOREIGN KEY (source_id) REFERENCES knowledge_sources(id) ON DELETE SET NULL NOT VALID;
                END IF;
            END $$;
        `);
    }
};

module.exports = [migration];
