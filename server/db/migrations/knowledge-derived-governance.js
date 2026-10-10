'use strict';

// 知识图谱与派生 Wiki 的第二阶段治理能力。所有 DDL 均为幂等形式，既可升级
// 已部署库，也与 pg schema snapshot 保持同一逻辑模型。
module.exports = [{
    id: '202610100001_knowledge_derived_governance',
    description: 'Add source lifecycle outbox, graph claims/evidence, graph provenance, and reproducible Wiki compile inputs.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE knowledge_entities ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'auto';
            ALTER TABLE knowledge_entities ADD COLUMN IF NOT EXISTS frozen BOOLEAN NOT NULL DEFAULT FALSE;
            ALTER TABLE knowledge_entities ADD COLUMN IF NOT EXISTS evidence_count BIGINT NOT NULL DEFAULT 0;
            ALTER TABLE knowledge_entities ADD COLUMN IF NOT EXISTS last_evidence_at TIMESTAMPTZ;

            ALTER TABLE knowledge_entity_mentions ADD COLUMN IF NOT EXISTS source_state TEXT NOT NULL DEFAULT 'active';
            ALTER TABLE knowledge_entity_mentions ADD COLUMN IF NOT EXISTS extractor_version TEXT NOT NULL DEFAULT 'rule-heuristic-v1';
            ALTER TABLE knowledge_entity_mentions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai');

            ALTER TABLE knowledge_relations ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'rule';
            ALTER TABLE knowledge_relations ADD COLUMN IF NOT EXISTS frozen BOOLEAN NOT NULL DEFAULT FALSE;
            ALTER TABLE knowledge_relations ADD COLUMN IF NOT EXISTS source_state TEXT NOT NULL DEFAULT 'active';
            ALTER TABLE knowledge_relations ADD COLUMN IF NOT EXISTS evidence_count BIGINT NOT NULL DEFAULT 0;
            ALTER TABLE knowledge_relations ADD COLUMN IF NOT EXISTS last_evidence_at TIMESTAMPTZ;
            ALTER TABLE knowledge_relations ADD COLUMN IF NOT EXISTS extractor_version TEXT NOT NULL DEFAULT 'rule-heuristic-v1';

            ALTER TABLE knowledge_wiki_pages ADD COLUMN IF NOT EXISTS claims_json JSONB NOT NULL DEFAULT '[]'::jsonb;
            ALTER TABLE knowledge_wiki_compile_runs ADD COLUMN IF NOT EXISTS superseded_by UUID;
            -- 旧页面没有可逐声明回放的来源映射，不能继续进入问答；保留页面和
            -- 来源供管理员审阅，并要求用新的快照编译器重新生成。
            UPDATE knowledge_wiki_pages
            SET status = 'stale', updated_at = (NOW() AT TIME ZONE 'Asia/Shanghai')
            WHERE status = 'published'
              AND (jsonb_typeof(claims_json) <> 'array' OR jsonb_array_length(claims_json) = 0);

            CREATE TABLE IF NOT EXISTS knowledge_graph_claims (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                source_entity_id BIGINT NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
                target_entity_id BIGINT NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
                relation_type TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
                origin TEXT NOT NULL DEFAULT 'rule',
                frozen BOOLEAN NOT NULL DEFAULT FALSE,
                evidence_count BIGINT NOT NULL DEFAULT 0,
                last_evidence_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(user_id, source_entity_id, target_entity_id, relation_type),
                CHECK (source_entity_id <> target_entity_id)
            );

            CREATE TABLE IF NOT EXISTS knowledge_graph_claim_evidence (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                claim_id BIGINT NOT NULL REFERENCES knowledge_graph_claims(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                legacy_relation_id BIGINT REFERENCES knowledge_relations(id) ON DELETE SET NULL,
                source_doc_id BIGINT REFERENCES knowledge_docs(id) ON DELETE CASCADE,
                source_chunk_id BIGINT REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
                source_state TEXT NOT NULL DEFAULT 'active',
                extraction_method TEXT NOT NULL DEFAULT 'rule_heuristic',
                extractor_version TEXT NOT NULL DEFAULT 'rule-heuristic-v1',
                confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
                excerpt_hash TEXT NOT NULL DEFAULT '',
                locator_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(claim_id, source_doc_id, source_chunk_id)
            );

            CREATE TABLE IF NOT EXISTS knowledge_graph_merge_audits (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                source_entity_id BIGINT NOT NULL,
                target_entity_id BIGINT NOT NULL,
                payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                reverted_at TIMESTAMPTZ,
                reverted_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );

            CREATE TABLE IF NOT EXISTS knowledge_wiki_compile_inputs (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                run_id UUID NOT NULL REFERENCES knowledge_wiki_compile_runs(id) ON DELETE CASCADE,
                source_ordinal BIGINT NOT NULL,
                document_id BIGINT NOT NULL REFERENCES knowledge_documents(id) ON DELETE RESTRICT,
                version_id BIGINT NOT NULL REFERENCES knowledge_document_versions(id) ON DELETE RESTRICT,
                block_id BIGINT NOT NULL REFERENCES knowledge_blocks(id) ON DELETE RESTRICT,
                legacy_chunk_id BIGINT REFERENCES knowledge_chunks(id) ON DELETE SET NULL,
                document_title TEXT NOT NULL DEFAULT '',
                heading_path TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL DEFAULT '',
                content_hash TEXT NOT NULL DEFAULT '',
                source_locator_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                selected_reason TEXT NOT NULL DEFAULT '',
                token_estimate BIGINT NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(run_id, source_ordinal),
                UNIQUE(run_id, document_id, version_id, block_id, legacy_chunk_id)
            );

            CREATE TABLE IF NOT EXISTS knowledge_source_lifecycle_outbox (
                id UUID PRIMARY KEY,
                event_key TEXT NOT NULL UNIQUE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                legacy_doc_id BIGINT REFERENCES knowledge_docs(id) ON DELETE SET NULL,
                document_id BIGINT REFERENCES knowledge_documents(id) ON DELETE SET NULL,
                event_type TEXT NOT NULL,
                payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts BIGINT NOT NULL DEFAULT 0,
                available_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                locked_by TEXT NOT NULL DEFAULT '',
                locked_at TIMESTAMPTZ,
                last_error TEXT NOT NULL DEFAULT '',
                handled_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );

            CREATE INDEX IF NOT EXISTS idx_knowledge_entities_auto_gc
                ON knowledge_entities(user_id, origin, frozen, evidence_count, deleted_at);
            CREATE INDEX IF NOT EXISTS idx_kg_mentions_doc_state
                ON knowledge_entity_mentions(doc_id, source_state, entity_id);
            CREATE INDEX IF NOT EXISTS idx_kg_relations_source_state
                ON knowledge_relations(user_id, source_state, status, source_doc_id);
            CREATE INDEX IF NOT EXISTS idx_kg_claims_lookup
                ON knowledge_graph_claims(user_id, source_entity_id, target_entity_id, relation_type, status);
            CREATE INDEX IF NOT EXISTS idx_kg_claim_evidence_source
                ON knowledge_graph_claim_evidence(source_doc_id, source_state, claim_id);
            CREATE INDEX IF NOT EXISTS idx_kg_claim_evidence_claim
                ON knowledge_graph_claim_evidence(claim_id, source_state, confidence DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_graph_merge_audits_user
                ON knowledge_graph_merge_audits(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_wiki_compile_inputs_run
                ON knowledge_wiki_compile_inputs(run_id, source_ordinal);
            CREATE INDEX IF NOT EXISTS idx_wiki_compile_inputs_source
                ON knowledge_wiki_compile_inputs(document_id, version_id, block_id);
            CREATE INDEX IF NOT EXISTS idx_knowledge_source_lifecycle_outbox_claim
                ON knowledge_source_lifecycle_outbox(status, available_at, created_at);
            CREATE INDEX IF NOT EXISTS idx_knowledge_source_lifecycle_outbox_doc
                ON knowledge_source_lifecycle_outbox(legacy_doc_id, document_id, created_at DESC);

            -- 将兼容读模型中的历史关系投影为 claim/evidence；新写入由服务层双写。
            INSERT INTO knowledge_graph_claims (
                user_id, source_entity_id, target_entity_id, relation_type, description,
                status, confidence, origin, frozen, created_at, updated_at
            )
            SELECT relation.user_id, relation.source_entity_id, relation.target_entity_id, relation.relation_type,
                   relation.description, relation.status, relation.confidence,
                   COALESCE(NULLIF(relation.origin, ''), 'rule'), COALESCE(relation.frozen, FALSE),
                   relation.created_at, relation.updated_at
            FROM knowledge_relations relation
            WHERE relation.source_entity_id <> relation.target_entity_id
            ON CONFLICT (user_id, source_entity_id, target_entity_id, relation_type) DO NOTHING;

            INSERT INTO knowledge_graph_claim_evidence (
                claim_id, user_id, legacy_relation_id, source_doc_id, source_chunk_id, source_state,
                extraction_method, extractor_version, confidence, created_at, updated_at
            )
            SELECT claim.id, relation.user_id, relation.id, relation.source_doc_id, relation.source_chunk_id,
                   COALESCE(NULLIF(relation.source_state, ''), 'active'),
                   CASE WHEN relation.origin = 'heuristic' THEN 'co_occurrence' ELSE 'rule_heuristic' END,
                   COALESCE(NULLIF(relation.extractor_version, ''), 'rule-heuristic-v1'), relation.confidence,
                   relation.created_at, relation.updated_at
            FROM knowledge_relations relation
            JOIN knowledge_graph_claims claim
              ON claim.user_id = relation.user_id
             AND claim.source_entity_id = relation.source_entity_id
             AND claim.target_entity_id = relation.target_entity_id
             AND claim.relation_type = relation.relation_type
            WHERE relation.source_doc_id IS NOT NULL OR relation.source_chunk_id IS NOT NULL
            ON CONFLICT (claim_id, source_doc_id, source_chunk_id) DO NOTHING;

            UPDATE knowledge_graph_claims claim
            SET evidence_count = totals.evidence_count,
                last_evidence_at = totals.last_evidence_at,
                confidence = CASE WHEN claim.frozen THEN claim.confidence ELSE totals.confidence END,
                status = CASE WHEN claim.frozen THEN claim.status
                    WHEN totals.evidence_count > 0 AND totals.confidence >= 0.6 THEN 'active'
                    WHEN totals.evidence_count > 0 THEN 'pending' ELSE 'deleted' END
            FROM (
                SELECT claim_id, COUNT(*) AS evidence_count, MAX(updated_at) AS last_evidence_at,
                       MAX(confidence) AS confidence
                FROM knowledge_graph_claim_evidence WHERE source_state = 'active'
                GROUP BY claim_id
            ) totals
            WHERE claim.id = totals.claim_id;

            UPDATE knowledge_relations relation
            SET evidence_count = claim.evidence_count, last_evidence_at = claim.last_evidence_at
            FROM knowledge_graph_claims claim
            JOIN knowledge_graph_claim_evidence evidence ON evidence.claim_id = claim.id
            WHERE evidence.legacy_relation_id = relation.id;
        `);
        await client.query(`
            UPDATE knowledge_entities entity
            SET evidence_count = totals.evidence_count, last_evidence_at = totals.last_evidence_at
            FROM (
                SELECT mention.entity_id, COUNT(*) AS evidence_count, MAX(mention.updated_at) AS last_evidence_at
                FROM knowledge_entity_mentions mention
                JOIN knowledge_docs document ON document.id = mention.doc_id
                WHERE COALESCE(mention.source_state, 'active') = 'active'
                  AND document.deleted_at IS NULL AND COALESCE(document.is_enabled, 1) = 1
                  AND document.status IN ('ready', 'lexical_ready')
                  AND COALESCE(document.lifecycle_status, 'published') NOT IN ('expired', 'archived')
                GROUP BY mention.entity_id
            ) totals
            WHERE entity.id = totals.entity_id;
        `);
    }
}];
