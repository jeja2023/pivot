'use strict';

// 开发环境的可扩展分析基础：版本化增量、分区 Parquet 与受控物化聚合。
// 实体数据继续留在受控数据目录；数据库仅保存路径、版本、摘要与可审计元数据。
module.exports = [{
    id: '202610100005_analysis_scalability',
    description: 'Add versioned incremental ingestion, managed parquet partitions and governed materializations for data analysis.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE analysis_datasets ADD COLUMN IF NOT EXISTS storage_mode TEXT NOT NULL DEFAULT 'managed_fs';
            ALTER TABLE analysis_datasets ADD COLUMN IF NOT EXISTS partition_root_path TEXT NOT NULL DEFAULT '';
            ALTER TABLE analysis_datasets ADD COLUMN IF NOT EXISTS partition_field_key TEXT NOT NULL DEFAULT '';

            CREATE TABLE IF NOT EXISTS analysis_dataset_versions (
                id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL REFERENCES analysis_datasets(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                version BIGINT NOT NULL,
                operation TEXT NOT NULL DEFAULT 'import',
                parquet_path TEXT NOT NULL,
                source_path TEXT NOT NULL DEFAULT '',
                row_count BIGINT NOT NULL DEFAULT 0,
                column_count BIGINT NOT NULL DEFAULT 0,
                manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(dataset_id, version)
            );

            CREATE TABLE IF NOT EXISTS analysis_dataset_partitions (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                dataset_id TEXT NOT NULL REFERENCES analysis_datasets(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                dataset_version BIGINT NOT NULL,
                field_key TEXT NOT NULL,
                field_value TEXT NOT NULL,
                row_count BIGINT NOT NULL DEFAULT 0,
                partition_root_path TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(dataset_id, dataset_version, field_key, field_value)
            );

            CREATE TABLE IF NOT EXISTS analysis_materializations (
                id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL REFERENCES analysis_datasets(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                source_version BIGINT NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'ready',
                result_file_path TEXT NOT NULL DEFAULT '',
                row_count BIGINT NOT NULL DEFAULT 0,
                columns_json JSONB NOT NULL DEFAULT '[]'::jsonb,
                preview_json JSONB NOT NULL DEFAULT '[]'::jsonb,
                last_error TEXT NOT NULL DEFAULT '',
                version BIGINT NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                deleted_at TIMESTAMPTZ
            );

            CREATE INDEX IF NOT EXISTS idx_analysis_dataset_versions_owner
                ON analysis_dataset_versions(user_id, dataset_id, version DESC);
            CREATE INDEX IF NOT EXISTS idx_analysis_dataset_partitions_dataset
                ON analysis_dataset_partitions(dataset_id, dataset_version DESC, field_key, field_value);
            CREATE INDEX IF NOT EXISTS idx_analysis_materializations_visible
                ON analysis_materializations(user_id, dataset_id, deleted_at, updated_at DESC);
        `);
    }
}];
