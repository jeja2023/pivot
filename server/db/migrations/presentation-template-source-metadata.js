'use strict';

/** 兼容已运行首个模板版本迁移的环境，补齐源文件审计字段。 */
const migration = {
    id: '202609250002_presentation_template_source_metadata',
    description: 'Add source package metadata to existing presentation template version snapshots.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE presentation_template_versions
                ADD COLUMN IF NOT EXISTS source_object_id VARCHAR(64) NULL REFERENCES agent_artifact_objects(id) ON DELETE SET NULL;
            ALTER TABLE presentation_template_versions
                ADD COLUMN IF NOT EXISTS import_options_json TEXT NOT NULL DEFAULT '{}';
        `);
    },
    async downPg(client) {
        await client.query(`
            ALTER TABLE presentation_template_versions DROP COLUMN IF EXISTS import_options_json;
            ALTER TABLE presentation_template_versions DROP COLUMN IF EXISTS source_object_id;
        `);
    }
};

module.exports = [migration];
