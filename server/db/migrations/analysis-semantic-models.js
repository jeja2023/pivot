'use strict';

// 语义指标、跨数据集关系和异步查询控制面。关系定义只保存受控字段键，
// 运行时仍按数据集/字段 ACL 二次校验，避免保存配置成为越权通道。
module.exports = [{
    id: '202610100004_analysis_semantic_models',
    description: 'Add semantic metric definitions, governed cross-dataset models and recoverable async query jobs.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS analysis_metric_definitions (
                id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL REFERENCES analysis_datasets(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                metric_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                unit TEXT NOT NULL DEFAULT '',
                scope TEXT NOT NULL DEFAULT 'personal',
                allowed_units TEXT NOT NULL DEFAULT '',
                allowed_user_ids TEXT NOT NULL DEFAULT '',
                valid_from TIMESTAMPTZ,
                valid_to TIMESTAMPTZ,
                version BIGINT NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                deleted_at TIMESTAMPTZ
            );
            CREATE TABLE IF NOT EXISTS analysis_data_models (
                id TEXT PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                scope TEXT NOT NULL DEFAULT 'personal',
                allowed_units TEXT NOT NULL DEFAULT '',
                allowed_user_ids TEXT NOT NULL DEFAULT '',
                version BIGINT NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                deleted_at TIMESTAMPTZ
            );
            CREATE TABLE IF NOT EXISTS analysis_data_model_relations (
                id TEXT PRIMARY KEY,
                model_id TEXT NOT NULL REFERENCES analysis_data_models(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                left_dataset_id TEXT NOT NULL REFERENCES analysis_datasets(id) ON DELETE CASCADE,
                left_field_key TEXT NOT NULL,
                right_dataset_id TEXT NOT NULL REFERENCES analysis_datasets(id) ON DELETE CASCADE,
                right_field_key TEXT NOT NULL,
                join_type TEXT NOT NULL DEFAULT 'left',
                cardinality TEXT NOT NULL DEFAULT 'many_to_one',
                status TEXT NOT NULL DEFAULT 'active',
                quality_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                CHECK (left_dataset_id <> right_dataset_id)
            );
            CREATE TABLE IF NOT EXISTS analysis_query_jobs (
                id TEXT PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                dataset_id TEXT NOT NULL REFERENCES analysis_datasets(id) ON DELETE CASCADE,
                sql_text TEXT NOT NULL,
                result_columns_json JSONB NOT NULL DEFAULT '[]'::jsonb,
                result_preview_json JSONB NOT NULL DEFAULT '[]'::jsonb,
                result_file_path TEXT NOT NULL DEFAULT '',
                requested_limit BIGINT NOT NULL DEFAULT 5000,
                status TEXT NOT NULL DEFAULT 'queued',
                progress BIGINT NOT NULL DEFAULT 0,
                attempts BIGINT NOT NULL DEFAULT 0,
                max_attempts BIGINT NOT NULL DEFAULT 3,
                last_error TEXT NOT NULL DEFAULT '',
                locked_at TIMESTAMPTZ,
                next_run_at TIMESTAMPTZ,
                started_at TIMESTAMPTZ,
                completed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_analysis_metric_definitions_visible
                ON analysis_metric_definitions(user_id, dataset_id, deleted_at, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_analysis_data_models_visible
                ON analysis_data_models(user_id, deleted_at, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_analysis_data_model_relations_model
                ON analysis_data_model_relations(model_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_analysis_query_jobs_due
                ON analysis_query_jobs(status, next_run_at, updated_at) WHERE status IN ('queued', 'retry_wait');
            CREATE INDEX IF NOT EXISTS idx_analysis_query_jobs_user
                ON analysis_query_jobs(user_id, dataset_id, created_at DESC);
        `);
    }
}];
