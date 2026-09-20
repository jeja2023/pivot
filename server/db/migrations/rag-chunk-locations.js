module.exports = [
    {
        id: '202609080001_rag_chunk_locations',
        description: 'Store deterministic chunk order and source character offsets for auditable citations.',
        async upPg(client) {
            await client.query(`
                ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS chunk_index BIGINT DEFAULT 0;
                ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS char_start BIGINT;
                ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS char_end BIGINT;
                CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc_position ON knowledge_chunks(doc_id, chunk_index);
            `);
        }
    }
];
