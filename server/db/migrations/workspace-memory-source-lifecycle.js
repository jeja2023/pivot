'use strict';

module.exports = [{
    id: '202610170013_workspace_memory_source_lifecycle',
    description: 'Persist retryable Memory source invalidation events emitted by attested local workspace connector results.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS workspace_memory_source_events (
                id UUID PRIMARY KEY,
                event_key CHAR(64) NOT NULL UNIQUE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                device_id VARCHAR(64) NOT NULL REFERENCES agent_local_devices(device_id) ON DELETE CASCADE,
                source_ref VARCHAR(255) NOT NULL,
                event_type VARCHAR(32) NOT NULL,
                source_revision CHAR(64) NOT NULL DEFAULT '',
                status VARCHAR(16) NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                locked_by VARCHAR(120) NOT NULL DEFAULT '',
                locked_at TIMESTAMPTZ,
                handled_at TIMESTAMPTZ,
                last_error TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CHECK (event_type IN ('source_changed', 'source_removed')),
                CHECK (status IN ('pending', 'claimed', 'completed'))
            );
            CREATE INDEX IF NOT EXISTS idx_workspace_memory_source_events_claim
                ON workspace_memory_source_events(status, available_at, created_at);
            CREATE INDEX IF NOT EXISTS idx_workspace_memory_source_events_source
                ON workspace_memory_source_events(user_id, source_ref, created_at DESC);
        `);
    }
}];
