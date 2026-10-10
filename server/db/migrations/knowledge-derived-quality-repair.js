'use strict';

// 兼容已错误标记第二批迁移、或在滚动发布期间只创建了基础 claim/evidence 表的
// 环境。该修复迁移只补列，因此可与 202610100002 安全重复执行。
module.exports = [{
    id: '202610100003_knowledge_derived_quality_repair',
    description: 'Repair missing graph claim quality columns for partially upgraded deployments.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE knowledge_graph_claim_evidence
                ADD COLUMN IF NOT EXISTS stance TEXT NOT NULL DEFAULT 'supports';
            ALTER TABLE knowledge_graph_claim_evidence
                ADD COLUMN IF NOT EXISTS excerpt_text TEXT NOT NULL DEFAULT '';
            ALTER TABLE knowledge_graph_claims
                ADD COLUMN IF NOT EXISTS confidence_reason_json JSONB NOT NULL DEFAULT '{}'::jsonb;
        `);
    }
}];
