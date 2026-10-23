'use strict';

const migration = {
    id: '202610230001_presentation_draft_content',
    description: 'Add draft content columns to presentation_documents to decouple auto-save from milestone version history.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE presentation_documents ADD COLUMN IF NOT EXISTS content_json TEXT NULL;
            ALTER TABLE presentation_documents ADD COLUMN IF NOT EXISTS validation_json TEXT NULL DEFAULT '{}';
        `);
        // 回填现有文档的草稿内容为当前版本的最新内容
        await client.query(`
            UPDATE presentation_documents d
            SET content_json = v.content_json, validation_json = v.validation_json
            FROM presentation_versions v
            WHERE v.presentation_id = d.id AND v.version = d.current_version
              AND d.content_json IS NULL;
        `);
        // 清理历史中多余的中间自动保存快照（保留当前版本和所有非自动保存的历史版本）
        await client.query(`
            DELETE FROM presentation_versions
            WHERE note = '自动保存'
              AND (presentation_id, version) NOT IN (
                  SELECT id, current_version FROM presentation_documents
              );
        `);
    },
    async downPg(client) {
        await client.query(`
            ALTER TABLE presentation_documents DROP COLUMN IF EXISTS content_json;
            ALTER TABLE presentation_documents DROP COLUMN IF EXISTS validation_json;
        `);
    }
};

module.exports = [migration];
