'use strict';

// 数据分析产品层：将一次性数据操作提升为可治理、可复用、可协作的分析资产。
// 所有表均保留用户归属和版本字段；共享只读，写入仍只允许资产所有者。
module.exports = [{
    id: '202610100003_analysis_bi_product',
    description: 'Add governed fields, calculated datasets, saved analysis views, dashboards and refresh alert control plane.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE analysis_datasets ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'personal';
            ALTER TABLE analysis_datasets ADD COLUMN IF NOT EXISTS allowed_units TEXT NOT NULL DEFAULT '';
            ALTER TABLE analysis_datasets ADD COLUMN IF NOT EXISTS allowed_user_ids TEXT NOT NULL DEFAULT '';
            ALTER TABLE analysis_datasets ADD COLUMN IF NOT EXISTS parent_dataset_id TEXT;
            ALTER TABLE analysis_datasets ADD COLUMN IF NOT EXISTS source_version BIGINT NOT NULL DEFAULT 1;

            CREATE TABLE IF NOT EXISTS analysis_field_governance (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                dataset_id TEXT NOT NULL REFERENCES analysis_datasets(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                field_key TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                logical_type TEXT NOT NULL DEFAULT 'auto',
                unit TEXT NOT NULL DEFAULT '',
                date_format TEXT NOT NULL DEFAULT '',
                sensitivity TEXT NOT NULL DEFAULT 'internal',
                business_definition TEXT NOT NULL DEFAULT '',
                is_dimension BOOLEAN NOT NULL DEFAULT FALSE,
                is_metric BOOLEAN NOT NULL DEFAULT FALSE,
                status TEXT NOT NULL DEFAULT 'active',
                revision BIGINT NOT NULL DEFAULT 1,
                metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(dataset_id, field_key)
            );

            CREATE TABLE IF NOT EXISTS analysis_calculated_fields (
                id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL REFERENCES analysis_datasets(id) ON DELETE CASCADE,
                output_dataset_id TEXT REFERENCES analysis_datasets(id) ON DELETE SET NULL,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                field_key TEXT NOT NULL,
                name TEXT NOT NULL,
                expression TEXT NOT NULL,
                dependencies_json JSONB NOT NULL DEFAULT '[]'::jsonb,
                logical_type TEXT NOT NULL DEFAULT 'number',
                unit TEXT NOT NULL DEFAULT '',
                sensitivity TEXT NOT NULL DEFAULT 'internal',
                status TEXT NOT NULL DEFAULT 'active',
                version BIGINT NOT NULL DEFAULT 1,
                preview_json JSONB NOT NULL DEFAULT '[]'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                deleted_at TIMESTAMPTZ
            );

            CREATE TABLE IF NOT EXISTS analysis_saved_views (
                id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL REFERENCES analysis_datasets(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                view_type TEXT NOT NULL,
                config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                source_version BIGINT NOT NULL DEFAULT 1,
                scope TEXT NOT NULL DEFAULT 'personal',
                allowed_units TEXT NOT NULL DEFAULT '',
                allowed_user_ids TEXT NOT NULL DEFAULT '',
                version BIGINT NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                deleted_at TIMESTAMPTZ
            );

            CREATE TABLE IF NOT EXISTS analysis_dashboards (
                id TEXT PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                scope TEXT NOT NULL DEFAULT 'personal',
                allowed_units TEXT NOT NULL DEFAULT '',
                allowed_user_ids TEXT NOT NULL DEFAULT '',
                version BIGINT NOT NULL DEFAULT 1,
                last_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                last_refreshed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                deleted_at TIMESTAMPTZ
            );

            CREATE TABLE IF NOT EXISTS analysis_dashboard_items (
                id TEXT PRIMARY KEY,
                dashboard_id TEXT NOT NULL REFERENCES analysis_dashboards(id) ON DELETE CASCADE,
                dataset_id TEXT NOT NULL REFERENCES analysis_datasets(id) ON DELETE CASCADE,
                saved_view_id TEXT REFERENCES analysis_saved_views(id) ON DELETE SET NULL,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL DEFAULT '',
                item_type TEXT NOT NULL DEFAULT 'chart',
                position_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                version BIGINT NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );

            CREATE TABLE IF NOT EXISTS analysis_refresh_schedules (
                id TEXT PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                dashboard_id TEXT REFERENCES analysis_dashboards(id) ON DELETE CASCADE,
                dataset_id TEXT REFERENCES analysis_datasets(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                frequency TEXT NOT NULL DEFAULT 'manual',
                cron_expression TEXT NOT NULL DEFAULT '',
                interval_minutes BIGINT NOT NULL DEFAULT 60,
                status TEXT NOT NULL DEFAULT 'active',
                next_run_at TIMESTAMPTZ,
                last_run_at TIMESTAMPTZ,
                last_status TEXT NOT NULL DEFAULT 'never',
                last_error TEXT NOT NULL DEFAULT '',
                failure_count BIGINT NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                CHECK (dashboard_id IS NOT NULL OR dataset_id IS NOT NULL)
            );

            CREATE TABLE IF NOT EXISTS analysis_alert_rules (
                id TEXT PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                dashboard_id TEXT REFERENCES analysis_dashboards(id) ON DELETE CASCADE,
                dataset_id TEXT NOT NULL REFERENCES analysis_datasets(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                metric_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                operator TEXT NOT NULL DEFAULT 'gt',
                threshold DOUBLE PRECISION NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'active',
                cooldown_minutes BIGINT NOT NULL DEFAULT 60,
                last_triggered_at TIMESTAMPTZ,
                last_value DOUBLE PRECISION,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );

            CREATE TABLE IF NOT EXISTS analysis_refresh_runs (
                id TEXT PRIMARY KEY,
                schedule_id TEXT REFERENCES analysis_refresh_schedules(id) ON DELETE SET NULL,
                dashboard_id TEXT REFERENCES analysis_dashboards(id) ON DELETE SET NULL,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                status TEXT NOT NULL DEFAULT 'queued',
                result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                error_message TEXT NOT NULL DEFAULT '',
                started_at TIMESTAMPTZ,
                completed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );

            CREATE INDEX IF NOT EXISTS idx_analysis_field_governance_dataset
                ON analysis_field_governance(dataset_id, field_key, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_analysis_calculated_fields_dataset
                ON analysis_calculated_fields(dataset_id, status, updated_at DESC) WHERE deleted_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_analysis_saved_views_visible
                ON analysis_saved_views(user_id, dataset_id, deleted_at, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_analysis_dashboards_visible
                ON analysis_dashboards(user_id, deleted_at, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_analysis_dashboard_items_dashboard
                ON analysis_dashboard_items(dashboard_id, updated_at ASC);
            CREATE INDEX IF NOT EXISTS idx_analysis_refresh_schedules_due
                ON analysis_refresh_schedules(status, next_run_at ASC) WHERE status = 'active';
            CREATE INDEX IF NOT EXISTS idx_analysis_alert_rules_active
                ON analysis_alert_rules(user_id, dataset_id, status, updated_at DESC) WHERE status = 'active';
            CREATE INDEX IF NOT EXISTS idx_analysis_refresh_runs_owner
                ON analysis_refresh_runs(user_id, created_at DESC);
        `);
    }
}];
