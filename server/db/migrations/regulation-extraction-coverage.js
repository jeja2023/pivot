'use strict';
module.exports = [{
    id: '202611100002_regulation_extraction_coverage',
    description: '保存法规资料提取完整性与原始页跨度，旧版本保留未知状态。',
    async upPg(client) {
        await client.query("ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS extraction_coverage_json JSONB NOT NULL DEFAULT '{}'::jsonb");
    }
}];
