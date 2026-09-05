// RAG 无模型精度增强所需的文档指纹与检索索引。
module.exports = [
    {
        id: '202609050006_rag_precision_signals',
        description: 'Add knowledge document fingerprints for deterministic duplicate detection.',
        up(db) {
            const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_docs'").get();
            if (!table) return;
            const columns = db.pragma('table_info(knowledge_docs)');
            if (!columns.some(column => column.name === 'source_hash')) {
                db.exec("ALTER TABLE knowledge_docs ADD COLUMN source_hash TEXT DEFAULT ''");
            }
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_knowledge_docs_user_source_hash
                    ON knowledge_docs(user_id, source_hash, deleted_at);
            `);
        },
        async upPg(client) {
            await client.query(`
                ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS source_hash VARCHAR(64) DEFAULT '';
                CREATE INDEX IF NOT EXISTS idx_knowledge_docs_user_source_hash
                    ON knowledge_docs(user_id, source_hash, deleted_at);
            `);
        }
    }
];
