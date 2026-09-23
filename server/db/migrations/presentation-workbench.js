'use strict';

/**
 * PPT 制作应用：文稿、版本、模板、素材与导出记录。
 *
 * 文稿正文是结构化 PPT IR；同时链接独立 Artifact，使可下载的 PPTX/PDF/PNG
 * 继续使用既有的 CAS → Rendition → Delivery 审计链。所有业务表按 tenant +
 * owner 双重隔离，不能只通过前端隐藏实现访问控制。
 */
const presentationWorkbenchMigration = {
    id: '202609220001_presentation_workbench_foundation',
    description: 'Add tenant-isolated presentation documents, templates, assets, versions and export records.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS presentation_documents (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                tenant_id BIGINT NOT NULL,
                owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                client_id VARCHAR(96) NOT NULL,
                artifact_id BIGINT NULL REFERENCES agent_artifacts(id) ON DELETE SET NULL,
                title VARCHAR(160) NOT NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'draft',
                aspect_ratio VARCHAR(8) NOT NULL DEFAULT '16:9',
                template_id VARCHAR(96) NOT NULL DEFAULT 'business-blue',
                template_version BIGINT NOT NULL DEFAULT 1,
                template_digest CHAR(64) NOT NULL DEFAULT '',
                current_version BIGINT NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                deleted_at TIMESTAMPTZ NULL,
                UNIQUE (tenant_id, owner_user_id, client_id),
                CONSTRAINT presentation_document_status_check CHECK (status IN ('draft', 'needs_attention', 'ready', 'archived')),
                CONSTRAINT presentation_document_ratio_check CHECK (aspect_ratio IN ('16:9', '4:3'))
            );
            CREATE INDEX IF NOT EXISTS idx_presentation_documents_owner_updated
                ON presentation_documents (tenant_id, owner_user_id, deleted_at, updated_at DESC);

            CREATE TABLE IF NOT EXISTS presentation_versions (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                presentation_id BIGINT NOT NULL REFERENCES presentation_documents(id) ON DELETE CASCADE,
                version BIGINT NOT NULL,
                artifact_version_id BIGINT NULL REFERENCES agent_artifact_versions(id) ON DELETE SET NULL,
                content_json TEXT NOT NULL,
                content_digest CHAR(64) NOT NULL,
                validation_json TEXT NOT NULL DEFAULT '{}',
                note VARCHAR(500) NOT NULL DEFAULT '',
                created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE (presentation_id, version)
            );
            CREATE INDEX IF NOT EXISTS idx_presentation_versions_document
                ON presentation_versions (presentation_id, version DESC);

            CREATE TABLE IF NOT EXISTS presentation_templates (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                tenant_id BIGINT NOT NULL,
                owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                client_id VARCHAR(96) NOT NULL,
                name VARCHAR(120) NOT NULL,
                description VARCHAR(500) NOT NULL DEFAULT '',
                owner_type VARCHAR(24) NOT NULL DEFAULT 'user',
                status VARCHAR(24) NOT NULL DEFAULT 'draft',
                scope VARCHAR(24) NOT NULL DEFAULT 'organization',
                aspect_ratio VARCHAR(8) NOT NULL DEFAULT '16:9',
                tags_json TEXT NOT NULL DEFAULT '[]',
                definition_json TEXT NOT NULL,
                snapshot_digest CHAR(64) NOT NULL,
                version BIGINT NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                deleted_at TIMESTAMPTZ NULL,
                UNIQUE (tenant_id, client_id),
                CONSTRAINT presentation_template_status_check CHECK (status IN ('draft', 'published', 'unpublished')),
                CONSTRAINT presentation_template_scope_check CHECK (scope IN ('private', 'organization', 'published')),
                CONSTRAINT presentation_template_ratio_check CHECK (aspect_ratio IN ('16:9', '4:3'))
            );
            CREATE INDEX IF NOT EXISTS idx_presentation_templates_visible
                ON presentation_templates (tenant_id, status, scope, updated_at DESC) WHERE deleted_at IS NULL;

            CREATE TABLE IF NOT EXISTS presentation_assets (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                tenant_id BIGINT NOT NULL,
                owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                object_id VARCHAR(64) NOT NULL REFERENCES agent_artifact_objects(id) ON DELETE RESTRICT,
                filename VARCHAR(240) NOT NULL,
                mime_type VARCHAR(128) NOT NULL,
                byte_size BIGINT NOT NULL,
                content_digest CHAR(64) NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                deleted_at TIMESTAMPTZ NULL,
                UNIQUE (tenant_id, owner_user_id, object_id)
            );
            CREATE INDEX IF NOT EXISTS idx_presentation_assets_owner
                ON presentation_assets (tenant_id, owner_user_id, deleted_at, created_at DESC);

            CREATE TABLE IF NOT EXISTS presentation_exports (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                presentation_id BIGINT NOT NULL REFERENCES presentation_documents(id) ON DELETE CASCADE,
                version BIGINT NOT NULL,
                rendition_id BIGINT NOT NULL REFERENCES agent_artifact_renditions(id) ON DELETE RESTRICT,
                format VARCHAR(16) NOT NULL,
                renderer_version VARCHAR(32) NOT NULL,
                status VARCHAR(24) NOT NULL DEFAULT 'ready',
                created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE (presentation_id, version, format, renderer_version),
                CONSTRAINT presentation_export_format_check CHECK (format IN ('pptx', 'pdf', 'png')),
                CONSTRAINT presentation_export_status_check CHECK (status IN ('queued', 'rendering', 'ready', 'failed', 'cancelled'))
            );
            CREATE INDEX IF NOT EXISTS idx_presentation_exports_document
                ON presentation_exports (presentation_id, updated_at DESC);
        `);
    },
    async downPg(client) {
        await client.query(`
            DROP TABLE IF EXISTS presentation_exports;
            DROP TABLE IF EXISTS presentation_assets;
            DROP TABLE IF EXISTS presentation_templates;
            DROP TABLE IF EXISTS presentation_versions;
            DROP TABLE IF EXISTS presentation_documents;
        `);
    }
};

module.exports = [presentationWorkbenchMigration];
