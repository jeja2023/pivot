'use strict';

// 导出和分发都可能调用较慢的文档渲染或外部业务服务。持久化请求状态、内容
// 版本和去重键，避免浏览器重试造成重复交付，也让服务重启后可以安全恢复。
module.exports = [{
    id: '202610130004_ocr_async_exports_and_distributions',
    description: 'Persist fixed-version OCR exports and idempotent result distributions.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS document_exports (
                id TEXT PRIMARY KEY,
                user_id BIGINT NOT NULL,
                job_id BIGINT NOT NULL,
                content_revision BIGINT NOT NULL DEFAULT 1,
                output_format TEXT NOT NULL DEFAULT 'txt',
                status TEXT NOT NULL DEFAULT 'queued',
                snapshot_json TEXT NOT NULL DEFAULT '{}',
                output_id BIGINT,
                error_message TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                completed_at TIMESTAMPTZ,
                UNIQUE(user_id, job_id, content_revision, output_format)
            );
            CREATE TABLE IF NOT EXISTS document_distributions (
                id TEXT PRIMARY KEY,
                user_id BIGINT NOT NULL,
                job_id BIGINT NOT NULL,
                target TEXT NOT NULL,
                content_revision BIGINT NOT NULL DEFAULT 1,
                options_hash TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                result_json TEXT NOT NULL DEFAULT '{}',
                error_message TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                completed_at TIMESTAMPTZ,
                UNIQUE(user_id, job_id, target, content_revision, options_hash)
            );
            CREATE INDEX IF NOT EXISTS idx_document_exports_user_status
                ON document_exports(user_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_document_distributions_user_status
                ON document_distributions(user_id, status, updated_at DESC);
        `);
    }
}];
