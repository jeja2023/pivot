'use strict';

module.exports = [{
    id: '202610220001_knowledge_claim_evidence_relation_index',
    description: '为知识图谱证据表补充 legacy_relation_id 索引，消除实体图谱查询时的全表扫描与超时。',
    async upPg(client) {
        await client.query(`CREATE INDEX IF NOT EXISTS idx_kg_claim_evidence_legacy_relation
            ON knowledge_graph_claim_evidence(legacy_relation_id, source_state)`);
    }
}];
