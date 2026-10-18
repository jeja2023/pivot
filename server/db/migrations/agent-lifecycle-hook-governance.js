'use strict';

module.exports = [{
    id: '202610170015_agent_lifecycle_hook_governance',
    description: 'Add immutable signed manifests, bounded execution contracts and privacy-preserving audits for lifecycle hooks.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_lifecycle_hooks
                ADD COLUMN IF NOT EXISTS manifest_digest VARCHAR(64) NOT NULL DEFAULT '',
                ADD COLUMN IF NOT EXISTS signature_key_id VARCHAR(160) NOT NULL DEFAULT '',
                ADD COLUMN IF NOT EXISTS timeout_ms INTEGER NOT NULL DEFAULT 1000;

            ALTER TABLE agent_lifecycle_hooks
                DROP CONSTRAINT IF EXISTS chk_agent_lifecycle_hooks_timeout;
            ALTER TABLE agent_lifecycle_hooks
                ADD CONSTRAINT chk_agent_lifecycle_hooks_timeout
                CHECK (timeout_ms >= 50 AND timeout_ms <= 5000);

            CREATE TABLE IF NOT EXISTS agent_lifecycle_hook_invocations (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                hook_id UUID NOT NULL REFERENCES agent_lifecycle_hooks(id) ON DELETE RESTRICT,
                tenant_id BIGINT NOT NULL DEFAULT 0,
                user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
                run_id VARCHAR(160) NOT NULL DEFAULT '',
                event_type VARCHAR(80) NOT NULL,
                phase VARCHAR(16) NOT NULL,
                sequence_no INTEGER NOT NULL,
                decision VARCHAR(32) NOT NULL,
                outcome VARCHAR(32) NOT NULL,
                reason VARCHAR(320) NOT NULL DEFAULT '',
                duration_ms INTEGER NOT NULL DEFAULT 0,
                payload_fingerprint VARCHAR(64) NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CHECK (phase IN ('pre', 'post')),
                CHECK (duration_ms >= 0)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_hook_invocations_run
                ON agent_lifecycle_hook_invocations(run_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_hook_invocations_hook
                ON agent_lifecycle_hook_invocations(hook_id, created_at DESC);
        `);
    }
}];
