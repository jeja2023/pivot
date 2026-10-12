'use strict';

// 第二批知识派生治理：不修改已发布的 202610100001 迁移，独立演进别名字典、
// evidence 立场和可解释置信度字段，保证已部署环境可顺序升级。
module.exports = [{
    id: '202610100002_knowledge_derived_quality',
    description: 'Add entity alias dictionary and evidence-aware graph claim quality metadata.',
    async upPg(client) {
        await client.query(`
            -- aliases 曾以 TEXT 保存；历史数据中还可能有空值、无效 JSON 或非数组 JSON。
            -- 使用当前连接的临时函数保证任意单条旧数据都不会中断整批迁移。
            CREATE OR REPLACE FUNCTION pg_temp.pivot_knowledge_aliases_to_jsonb(input TEXT)
            RETURNS JSONB
            LANGUAGE plpgsql
            IMMUTABLE
            AS $$
            DECLARE parsed JSONB;
            BEGIN
                IF input IS NULL OR btrim(input) = '' THEN
                    RETURN '[]'::jsonb;
                END IF;
                BEGIN
                    parsed := input::jsonb;
                EXCEPTION WHEN invalid_text_representation THEN
                    RETURN '[]'::jsonb;
                END;
                IF jsonb_typeof(parsed) <> 'array' THEN
                    RETURN '[]'::jsonb;
                END IF;
                RETURN parsed;
            END;
            $$;

            CREATE TABLE IF NOT EXISTS knowledge_entity_aliases (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                entity_id BIGINT NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
                alias TEXT NOT NULL,
                normalized_alias TEXT NOT NULL,
                source_kind TEXT NOT NULL DEFAULT 'auto',
                confidence DOUBLE PRECISION NOT NULL DEFAULT 0.7,
                approved_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(user_id, normalized_alias)
            );
            CREATE INDEX IF NOT EXISTS idx_knowledge_entity_aliases_entity
                ON knowledge_entity_aliases(entity_id, source_kind, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_entity_aliases_lookup
                ON knowledge_entity_aliases(user_id, normalized_alias);
            CREATE INDEX IF NOT EXISTS idx_knowledge_entity_aliases_trgm
                ON knowledge_entity_aliases USING gin (normalized_alias gin_trgm_ops);
            CREATE INDEX IF NOT EXISTS idx_knowledge_entities_name_trgm
                ON knowledge_entities USING gin (normalized_name gin_trgm_ops);

            ALTER TABLE knowledge_graph_claim_evidence
                ADD COLUMN IF NOT EXISTS stance TEXT NOT NULL DEFAULT 'supports';
            ALTER TABLE knowledge_graph_claim_evidence
                ADD COLUMN IF NOT EXISTS excerpt_text TEXT NOT NULL DEFAULT '';
            ALTER TABLE knowledge_graph_claims
                ADD COLUMN IF NOT EXISTS confidence_reason_json JSONB NOT NULL DEFAULT '{}'::jsonb;

            INSERT INTO knowledge_entity_aliases (
                user_id, entity_id, alias, normalized_alias, source_kind, confidence, created_at, updated_at
            )
            SELECT entity.user_id, entity.id, entity.name, entity.normalized_name, 'canonical', entity.confidence,
                   entity.created_at, entity.updated_at
            FROM knowledge_entities entity
            WHERE entity.deleted_at IS NULL AND entity.normalized_name <> ''
            ON CONFLICT (user_id, normalized_alias) DO NOTHING;
            INSERT INTO knowledge_entity_aliases (
                user_id, entity_id, alias, normalized_alias, source_kind, confidence, created_at, updated_at
            )
            SELECT entity.user_id, entity.id, trim(alias.value),
                   lower(regexp_replace(trim(alias.value), '[^[:alnum:]一-龥_.-]+', '', 'g')),
                   'auto', entity.confidence, entity.created_at, entity.updated_at
            FROM knowledge_entities entity
            CROSS JOIN LATERAL jsonb_array_elements_text(
                pg_temp.pivot_knowledge_aliases_to_jsonb(entity.aliases::text)
            ) AS alias(value)
            WHERE entity.deleted_at IS NULL AND trim(alias.value) <> ''
            ON CONFLICT (user_id, normalized_alias) DO NOTHING;

            DROP FUNCTION IF EXISTS pg_temp.pivot_knowledge_aliases_to_jsonb(TEXT);
        `);
    }
}];
