'use strict';

// PDF 工作区使用同一文档底座。本迁移只扩展可审计的元数据和短期凭据隔离，
// 不改写原始文件或既有结果，保障部署回滚时旧记录仍然可读。
module.exports = [{
    id: '202610130002_pdf_tool_product_upgrade',
    description: 'Upgrade PDF tool jobs with safe secrets, page geometry, batch items, and output quality metadata.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS config_version BIGINT NOT NULL DEFAULT 1;
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT '';
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS parent_job_id BIGINT;
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS attempt_token TEXT NOT NULL DEFAULT '';
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT NOT NULL DEFAULT '';
            ALTER TABLE document_jobs ADD COLUMN IF NOT EXISTS quality_json TEXT NOT NULL DEFAULT '{}';

            ALTER TABLE document_pages ADD COLUMN IF NOT EXISTS pixel_width BIGINT NOT NULL DEFAULT 0;
            ALTER TABLE document_pages ADD COLUMN IF NOT EXISTS pixel_height BIGINT NOT NULL DEFAULT 0;
            ALTER TABLE document_pages ADD COLUMN IF NOT EXISTS pdf_width DOUBLE PRECISION NOT NULL DEFAULT 0;
            ALTER TABLE document_pages ADD COLUMN IF NOT EXISTS pdf_height DOUBLE PRECISION NOT NULL DEFAULT 0;
            ALTER TABLE document_pages ADD COLUMN IF NOT EXISTS rotation BIGINT NOT NULL DEFAULT 0;
            ALTER TABLE document_pages ADD COLUMN IF NOT EXISTS crop_box_json TEXT NOT NULL DEFAULT '{}';

            ALTER TABLE document_outputs ADD COLUMN IF NOT EXISTS page_count BIGINT NOT NULL DEFAULT 0;
            ALTER TABLE document_outputs ADD COLUMN IF NOT EXISTS sha256 TEXT NOT NULL DEFAULT '';
            ALTER TABLE document_outputs ADD COLUMN IF NOT EXISTS quality_json TEXT NOT NULL DEFAULT '{}';
            ALTER TABLE document_outputs ADD COLUMN IF NOT EXISTS version_key TEXT NOT NULL DEFAULT '';

            CREATE TABLE IF NOT EXISTS document_job_items (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL,
                job_id BIGINT NOT NULL,
                file_id BIGINT NOT NULL,
                item_order BIGINT NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'queued',
                progress BIGINT NOT NULL DEFAULT 0,
                error_code TEXT NOT NULL DEFAULT '',
                error_message TEXT NOT NULL DEFAULT '',
                result_json TEXT NOT NULL DEFAULT '{}',
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE TABLE IF NOT EXISTS document_job_secrets (
                id TEXT PRIMARY KEY,
                user_id BIGINT NOT NULL,
                job_id BIGINT NOT NULL,
                secret_purpose TEXT NOT NULL,
                encrypted_value TEXT NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                deleted_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE TABLE IF NOT EXISTS document_artifact_refs (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL,
                output_id BIGINT NOT NULL,
                ref_type TEXT NOT NULL,
                ref_id TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(output_id, ref_type, ref_id)
            );
            CREATE INDEX IF NOT EXISTS idx_document_jobs_pdf_lifecycle
                ON document_jobs(user_id, source_module, status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_document_jobs_pdf_retry
                ON document_jobs(status, lease_until, cancel_requested_at);
            CREATE INDEX IF NOT EXISTS idx_document_job_items_job_status
                ON document_job_items(job_id, status, item_order);
            CREATE INDEX IF NOT EXISTS idx_document_job_secrets_expiry
                ON document_job_secrets(expires_at, deleted_at);
            CREATE INDEX IF NOT EXISTS idx_document_outputs_lifecycle
                ON document_outputs(user_id, status, expires_at);
        `);
    }
}];
