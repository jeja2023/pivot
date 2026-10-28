'use strict';

module.exports = [{
    id: '202610280003_knowledge_source_deletion_approval',
    description: 'Store single-use, expiring approvals bound to an exact source deletion preview.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS knowledge_source_deletion_approvals (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                source_id BIGINT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
                run_id BIGINT NOT NULL REFERENCES knowledge_source_sync_runs(id) ON DELETE CASCADE,
                snapshot_hash TEXT NOT NULL,
                approved_by BIGINT NOT NULL REFERENCES users(id),
                status TEXT NOT NULL DEFAULT 'approved',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                expires_at TIMESTAMPTZ NOT NULL,
                consumed_at TIMESTAMPTZ,
                UNIQUE (run_id)
            );
        `);
    }
}];
