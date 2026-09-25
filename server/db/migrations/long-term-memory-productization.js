'use strict';

/*
 * 长期记忆生命周期加固。结构快照为新安装创建字段；此迁移让既有
 * PostgreSQL 部署兼容升级，且不改写历史记忆正文。
 */
module.exports = [{
    id: '202609260001_long_term_memory_productization',
    description: 'Add memory lifecycle, provenance, suppression, and usage-event contracts.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE memories ADD COLUMN IF NOT EXISTS scope_reference TEXT DEFAULT '';
            ALTER TABLE memories ADD COLUMN IF NOT EXISTS project_id TEXT DEFAULT '';
            ALTER TABLE memories ADD COLUMN IF NOT EXISTS origin VARCHAR(24) NOT NULL DEFAULT 'automatic';
            ALTER TABLE memories ADD COLUMN IF NOT EXISTS asserted_by VARCHAR(24) NOT NULL DEFAULT 'user';
            ALTER TABLE memories ADD COLUMN IF NOT EXISTS fact_key TEXT DEFAULT '';
            ALTER TABLE memories ADD COLUMN IF NOT EXISTS supersedes_id BIGINT;
            ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_status VARCHAR(24) NOT NULL DEFAULT 'lexical_ready';
            ALTER TABLE memories ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
            ALTER TABLE memories ADD COLUMN IF NOT EXISTS revocation_reason VARCHAR(80) DEFAULT '';
            ALTER TABLE memory_extraction_jobs ADD COLUMN IF NOT EXISTS memory_revision BIGINT NOT NULL DEFAULT 0;

            UPDATE memories
            SET origin = CASE WHEN origin IS NULL OR origin = '' THEN 'automatic' ELSE origin END,
                asserted_by = CASE WHEN asserted_by IS NULL OR asserted_by = '' THEN 'user' ELSE asserted_by END,
                embedding_status = CASE
                    WHEN embedding IS NOT NULL AND (embedding_status IS NULL OR embedding_status = '' OR embedding_status = 'lexical_ready') THEN 'ready'
                    WHEN embedding_status IS NULL OR embedding_status = '' THEN 'lexical_ready'
                    ELSE embedding_status
                END,
                fact_key = COALESCE(NULLIF(fact_key, ''), '')
            WHERE origin IS NULL OR origin = ''
               OR asserted_by IS NULL OR asserted_by = ''
               OR embedding_status IS NULL OR embedding_status = '';

            CREATE TABLE IF NOT EXISTS memory_source_evidence (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                memory_id BIGINT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                session_id TEXT,
                message_id BIGINT,
                source_kind VARCHAR(24) NOT NULL DEFAULT 'automatic',
                asserted_by VARCHAR(24) NOT NULL DEFAULT 'user',
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(memory_id, message_id)
            );

            CREATE TABLE IF NOT EXISTS memory_suppressions (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                fingerprint TEXT NOT NULL,
                source_session_id TEXT,
                source_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
                reason VARCHAR(80) NOT NULL DEFAULT 'user_forget',
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                released_at TIMESTAMPTZ,
                released_by VARCHAR(24) DEFAULT '',
                UNIQUE(user_id, fingerprint)
            );

            CREATE TABLE IF NOT EXISTS memory_usage_events (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                memory_id BIGINT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
                event_type VARCHAR(24) NOT NULL,
                session_id TEXT,
                run_id TEXT,
                query_fingerprint TEXT DEFAULT '',
                rank INTEGER,
                score DOUBLE PRECISION,
                reason VARCHAR(160) DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );

            INSERT INTO memory_source_evidence (memory_id, user_id, session_id, message_id, source_kind, asserted_by, created_at)
            SELECT m.id, m.user_id, m.source_session_id, source_value.message_id_text::BIGINT, m.origin, m.asserted_by, m.created_at
            FROM memories m
            CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(m.source_message_ids, '[]'::jsonb)) AS source_value(message_id_text)
            WHERE source_value.message_id_text ~ '^[0-9]+$'
            ON CONFLICT(memory_id, message_id) DO NOTHING;

            CREATE INDEX IF NOT EXISTS idx_memories_retrieval_scope
                ON memories(user_id, status, scope, scope_reference, project_id, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memories_fact_key
                ON memories(user_id, type, fact_key) WHERE status <> 'deleted';
            CREATE INDEX IF NOT EXISTS idx_memory_jobs_revision
                ON memory_extraction_jobs(user_id, memory_revision, status, next_run_at);
            CREATE INDEX IF NOT EXISTS idx_memory_source_evidence_session
                ON memory_source_evidence(user_id, session_id, memory_id);
            CREATE INDEX IF NOT EXISTS idx_memory_suppressions_active
                ON memory_suppressions(user_id, fingerprint) WHERE released_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_memory_usage_events_memory
                ON memory_usage_events(user_id, memory_id, created_at DESC);
        `);
    }
}];
