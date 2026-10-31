'use strict';

module.exports = [{
    id: '202610310002_presentation_shared_presence',
    description: 'Store bounded-lifetime presentation presence for multi-node deployments.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS presentation_shared_presence (
                presentation_id BIGINT NOT NULL REFERENCES presentation_documents(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                slide_id TEXT NOT NULL DEFAULT '', selected_element_id TEXT NOT NULL DEFAULT '',
                is_editing BOOLEAN NOT NULL DEFAULT FALSE, last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (presentation_id, user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_presentation_presence_expiry ON presentation_shared_presence(last_seen_at);
        `);
    },
    async checkPg(client) {
        const result = await client.query(`
            SELECT to_regclass(format('%I.%I', current_schema(), 'presentation_shared_presence')) IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = current_schema() AND c.relname = 'idx_presentation_presence_expiry'
                  AND i.indrelid = to_regclass(format('%I.%I', current_schema(), 'presentation_shared_presence'))
                  AND i.indisvalid AND i.indisready
              ) AS present
        `);
        return result.rows[0]?.present === true;
    }
}];
