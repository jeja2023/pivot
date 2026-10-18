'use strict';

// 与初始来源指纹迁移分离：已部署的迁移文件必须保持不可变。
module.exports = [{
    id: '202610170011_long_term_memory_source_review_audit',
    description: 'Record who completed a Memory source review and when it was completed.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE memory_source_evidence ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
            ALTER TABLE memory_source_evidence ADD COLUMN IF NOT EXISTS reviewed_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
            CREATE INDEX IF NOT EXISTS idx_memory_source_evidence_review_queue
                ON memory_source_evidence(user_id, review_required_at, memory_id)
                WHERE review_required_at IS NOT NULL;
        `);
    }
}];
