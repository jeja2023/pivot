'use strict';

module.exports = [{
    id: '202609260003_long_term_memory_embedding_recovery',
    description: 'Track long-term memory embedding dimensions for recovery and ANN indexing.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_dimensions BIGINT NOT NULL DEFAULT 0;
            UPDATE memories
            SET embedding_dimensions = CASE WHEN embedding IS NOT NULL THEN vector_dims(embedding) ELSE 0 END
            WHERE embedding_dimensions IS NULL OR embedding_dimensions = 0;
            CREATE INDEX IF NOT EXISTS idx_memories_embedding_recovery
                ON memories(status, embedding_status, updated_at ASC)
                WHERE status = 'active';
        `);
    }
}];
