'use strict';

module.exports = [{
    id: '202609260005_long_term_memory_validity_window',
    description: 'Add validity start timestamps to governed long-term memories.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE memories ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
            UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL;
            CREATE INDEX IF NOT EXISTS idx_memories_validity_window
                ON memories(user_id, status, valid_from, expires_at);
        `);
    }
}];
