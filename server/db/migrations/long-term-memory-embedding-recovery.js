'use strict';

module.exports = [{
    id: '202609260003_long_term_memory_embedding_recovery',
    description: 'Track long-term memory embedding dimensions for recovery and ANN indexing.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_dimensions BIGINT NOT NULL DEFAULT 0;

            -- 早期生产库的 embedding 可能保留为 TEXT，而新快照使用 pgvector。
            -- vector_dims(TEXT) 会直接中断启动；两种类型都可安全转为文本的
            -- "[1,2,...]" 表示，再只接受纯数值数组计算维度。
            CREATE OR REPLACE FUNCTION pg_temp.pivot_memory_embedding_dimensions(input TEXT)
            RETURNS BIGINT
            LANGUAGE plpgsql
            AS $function$
            DECLARE
                parsed JSONB;
            BEGIN
                IF input IS NULL OR BTRIM(input) = '' THEN
                    RETURN 0;
                END IF;
                parsed := input::jsonb;
                IF jsonb_typeof(parsed) <> 'array' OR jsonb_array_length(parsed) = 0 THEN
                    RETURN 0;
                END IF;
                IF EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(parsed) AS item(value)
                    WHERE jsonb_typeof(item.value) <> 'number'
                ) THEN
                    RETURN 0;
                END IF;
                RETURN jsonb_array_length(parsed);
            EXCEPTION WHEN others THEN
                RETURN 0;
            END;
            $function$;

            UPDATE memories
            SET embedding_dimensions = pg_temp.pivot_memory_embedding_dimensions(embedding::text)
            WHERE embedding_dimensions IS NULL OR embedding_dimensions = 0;

            DROP FUNCTION IF EXISTS pg_temp.pivot_memory_embedding_dimensions(TEXT);

            CREATE INDEX IF NOT EXISTS idx_memories_embedding_recovery
                ON memories(status, embedding_status, updated_at ASC)
                WHERE status = 'active';
        `);
    }
}];
