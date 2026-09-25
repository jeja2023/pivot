'use strict';

/** 外部模板解析任务：源包已持久化后才进入队列，避免临时上传文件丢失。 */
const migration = {
    id: '202609250003_presentation_template_import_jobs',
    description: 'Add durable presentation template import jobs with source package and compatibility result tracking.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS presentation_template_import_jobs (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                tenant_id BIGINT NOT NULL,
                owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                client_id VARCHAR(96) NOT NULL,
                source_object_id VARCHAR(64) NOT NULL REFERENCES agent_artifact_objects(id) ON DELETE RESTRICT,
                filename VARCHAR(240) NOT NULL,
                mime_type VARCHAR(128) NOT NULL,
                scope VARCHAR(24) NOT NULL DEFAULT 'organization',
                department_name VARCHAR(120) NOT NULL DEFAULT '',
                import_mode VARCHAR(24) NOT NULL DEFAULT 'editable',
                publish_requested BOOLEAN NOT NULL DEFAULT true,
                status VARCHAR(24) NOT NULL DEFAULT 'queued',
                template_client_id VARCHAR(96) NOT NULL DEFAULT '',
                result_json TEXT NOT NULL DEFAULT '{}',
                error_code VARCHAR(96) NOT NULL DEFAULT '',
                error_message VARCHAR(1000) NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                started_at TIMESTAMPTZ NULL,
                completed_at TIMESTAMPTZ NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE (tenant_id, client_id),
                CONSTRAINT presentation_template_import_job_scope_check CHECK (scope IN ('private', 'organization', 'department')),
                CONSTRAINT presentation_template_import_job_mode_check CHECK (import_mode IN ('editable', 'fidelity')),
                CONSTRAINT presentation_template_import_job_status_check CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled'))
            );
            CREATE INDEX IF NOT EXISTS idx_presentation_template_import_jobs_owner
                ON presentation_template_import_jobs (tenant_id, owner_user_id, status, updated_at DESC);
        `);
    },
    async downPg(client) {
        await client.query('DROP TABLE IF EXISTS presentation_template_import_jobs;');
    }
};

module.exports = [migration];
