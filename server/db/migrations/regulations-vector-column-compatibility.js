'use strict';

// 早期生产库的法规条文向量列曾以 TEXT 保存 JSON 数组。虽然写入不会失败，
// 但 pgvector 的 <=> 算子不能对 text 工作，导致“已建索引”仍无法语义召回。
// 不能在启动迁移中直接 ALTER COLUMN 到 vector：某些生产库已存在由旧运维
// 脚本创建的 ANN 表达式索引，PostgreSQL 会尝试重建它们，而无维度 vector 会
// 被 pgvector 拒绝（column does not have dimensions）。因此保留兼容列类型，
// 由查询层显式 ::vector，并重排当前版本让新向量在统一 profile 下重建。
module.exports = [{
    id: '202610140001_regulations_vector_column_compatibility',
    description: 'Safely requeue legacy regulation text embeddings without rewriting production vector indexes.',
    async upPg(client) {
        await client.query('SET LOCAL statement_timeout = 0');
        await client.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
        await client.query(`
            DO $migration$
            DECLARE
                embedding_type TEXT;
                legacy_embedding BOOLEAN := FALSE;
                queued_versions BIGINT := 0;
            BEGIN
                SELECT format_type(attribute.atttypid, attribute.atttypmod)
                  INTO embedding_type
                FROM pg_attribute attribute
                JOIN pg_class relation ON relation.oid = attribute.attrelid
                JOIN pg_namespace schema_name ON schema_name.oid = relation.relnamespace
                WHERE schema_name.nspname = current_schema()
                  AND relation.relname = 'regulation_articles'
                  AND attribute.attname = 'embedding'
                  AND attribute.attnum > 0
                  AND NOT attribute.attisdropped;

                IF embedding_type IS NULL THEN
                    RAISE EXCEPTION 'regulation_articles.embedding 不存在，无法修复法规向量索引';
                END IF;

                -- 仅当实际不是 vector 类型（例如为历史 text 或 varchar）时才标记为旧数据。
                -- 避免将 vector(1024)、vector(1536) 或带 schema 限定词的合法向量列误判为 legacy。
                IF lower(embedding_type) NOT LIKE '%vector%' THEN
                    legacy_embedding := TRUE;
                END IF;

                -- 仅在发现旧 TEXT 列时执行一次全量当前版本回填。即使部分旧值可以
                -- 转换，也需要以正在使用的系统模型重建，防止旧模型、旧维度或 profile
                -- 混入检索空间。这里刻意不 ALTER COLUMN，避免触发现有 ANN 索引重建。
                IF legacy_embedding THEN
                    UPDATE regulation_articles article
                    SET embedding = NULL, embedding_profile = ''
                    FROM regulation_documents document
                    WHERE article.document_id = document.id
                      AND article.version_id = document.current_version_id
                      AND document.deleted_at IS NULL
                      AND document.status <> 'archived'
                      AND (article.embedding IS NOT NULL OR COALESCE(article.embedding_profile, '') <> '');

                    UPDATE regulation_versions version
                    SET index_status = 'retry_wait',
                        index_error = '检测到法规历史 TEXT 向量，系统将使用当前向量模型自动补齐索引。',
                        index_attempts = 0,
                        index_max_attempts = 5,
                        index_next_retry_at = (NOW() AT TIME ZONE 'Asia/Shanghai'),
                        index_last_attempt_at = NULL,
                        embedding_profile = '',
                        updated_at = (NOW() AT TIME ZONE 'Asia/Shanghai')
                    FROM regulation_documents document
                    WHERE version.id = document.current_version_id
                      AND document.deleted_at IS NULL
                      AND document.status <> 'archived';
                    GET DIAGNOSTICS queued_versions = ROW_COUNT;
                    RAISE NOTICE '法规向量列已迁移为 pgvector；已重排队 % 个当前版本', queued_versions;
                END IF;
            END
            $migration$;

            -- 仅更新仍使用历史默认值的系统配置，保留管理员已经显式调整过的值。
            UPDATE app_settings SET value = '20', updated_at = (NOW() AT TIME ZONE 'Asia/Shanghai')
            WHERE key = 'rag_rerank_candidate_limit' AND value = '30';
            UPDATE app_settings SET value = '5000', updated_at = (NOW() AT TIME ZONE 'Asia/Shanghai')
            WHERE key = 'rag_rerank_timeout_ms' AND value = '1800';
        `);
    }
}];
