'use strict';

module.exports = [{
    id: '202609260004_long_term_memory_search_index',
    description: 'Add lexical search projection and index for long-term memory retrieval candidates.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_content TEXT DEFAULT '';
            UPDATE memories
            SET search_content = content
            WHERE search_content IS NULL OR search_content = '';
            CREATE INDEX IF NOT EXISTS idx_memories_search_content_trgm
                ON memories USING gin (search_content gin_trgm_ops)
                WHERE status = 'active';
        `);
    }
}];
