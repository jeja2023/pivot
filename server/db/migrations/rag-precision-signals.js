// RAG 无模型精度增强所需的文档指纹与检索索引。
module.exports = [
    {
        id: '202609050006_rag_precision_signals',
        description: 'Add knowledge document fingerprints for deterministic duplicate detection.',
        async upPg(client) {
            await client.query(`
                ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS source_hash VARCHAR(64) DEFAULT '';
                CREATE INDEX IF NOT EXISTS idx_knowledge_docs_user_source_hash
                    ON knowledge_docs(user_id, source_hash, deleted_at);
            `);
        }
    }
];
