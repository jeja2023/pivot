module.exports = [
    {
        id: '202609080001_rag_chunk_locations',
        description: 'Store deterministic chunk order and source character offsets for auditable citations.',
        up(db) {
            const columns = db.pragma('table_info(knowledge_chunks)');
            if (!columns.length) return;
            if (!columns.some(column => column.name === 'chunk_index')) db.exec('ALTER TABLE knowledge_chunks ADD COLUMN chunk_index INTEGER DEFAULT 0');
            if (!columns.some(column => column.name === 'char_start')) db.exec('ALTER TABLE knowledge_chunks ADD COLUMN char_start INTEGER');
            if (!columns.some(column => column.name === 'char_end')) db.exec('ALTER TABLE knowledge_chunks ADD COLUMN char_end INTEGER');
            db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc_position ON knowledge_chunks(doc_id, chunk_index)');
        },
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
