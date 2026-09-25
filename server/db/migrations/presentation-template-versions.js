'use strict';

/**
 * 模板定义不能只保存在当前行：文稿必须能在模板更新或下架后继续按创建时的
 * 版本编辑和导出。此表保留每次发布前后可解析的不可变定义快照。
 */
const migration = {
    id: '202609250001_presentation_template_versions',
    description: 'Add immutable presentation template definition snapshots for imported PPTX templates.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS presentation_template_versions (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                template_id BIGINT NOT NULL REFERENCES presentation_templates(id) ON DELETE CASCADE,
                version BIGINT NOT NULL,
                definition_json TEXT NOT NULL,
                snapshot_digest CHAR(64) NOT NULL,
                source_format VARCHAR(24) NOT NULL DEFAULT 'pivot',
                source_object_id VARCHAR(64) NULL REFERENCES agent_artifact_objects(id) ON DELETE SET NULL,
                import_options_json TEXT NOT NULL DEFAULT '{}',
                import_report_json TEXT NOT NULL DEFAULT '[]',
                created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE (template_id, version)
            );
            CREATE INDEX IF NOT EXISTS idx_presentation_template_versions_template
                ON presentation_template_versions (template_id, version DESC);
            INSERT INTO presentation_template_versions
                (template_id, version, definition_json, snapshot_digest, source_format, source_object_id, import_options_json, import_report_json, created_by, created_at)
            SELECT id, version, definition_json, snapshot_digest,
                   COALESCE(NULLIF(definition_json::jsonb #>> '{importMetadata,sourceFormat}', ''), 'pivot'),
                   NULL,
                   '{}'::jsonb::text,
                   COALESCE(definition_json::jsonb #> '{importMetadata,report}', '[]'::jsonb)::text,
                   owner_user_id, updated_at
            FROM presentation_templates
            ON CONFLICT (template_id, version) DO NOTHING;
        `);
    },
    async downPg(client) {
        await client.query('DROP TABLE IF EXISTS presentation_template_versions;');
    }
};

module.exports = [migration];
