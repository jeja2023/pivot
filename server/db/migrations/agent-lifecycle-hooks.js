'use strict';

module.exports = [{
    id: '202610170003_agent_lifecycle_hooks',
    description: 'Register typed, declarative, auditable lifecycle hooks that can only tighten Agent execution policy.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_lifecycle_hooks (
                id UUID PRIMARY KEY,
                tenant_id BIGINT NOT NULL DEFAULT 0,
                user_id BIGINT NULL REFERENCES users(id) ON DELETE CASCADE,
                package_id VARCHAR(160) NOT NULL DEFAULT 'platform',
                package_version VARCHAR(80) NOT NULL DEFAULT '1',
                hook_name VARCHAR(160) NOT NULL,
                event_type VARCHAR(80) NOT NULL,
                phase VARCHAR(16) NOT NULL,
                priority INTEGER NOT NULL DEFAULT 100,
                handler_kind VARCHAR(32) NOT NULL DEFAULT 'declarative_policy',
                config JSONB NOT NULL DEFAULT '{}'::jsonb,
                input_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
                output_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
                required_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
                failure_policy VARCHAR(16) NOT NULL DEFAULT 'fail_open',
                signature_verified BOOLEAN NOT NULL DEFAULT false,
                status VARCHAR(16) NOT NULL DEFAULT 'disabled',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CHECK (phase IN ('pre', 'post')),
                CHECK (handler_kind IN ('declarative_policy')),
                CHECK (failure_policy IN ('fail_open', 'fail_closed')),
                CHECK (status IN ('enabled', 'disabled', 'retired')),
                UNIQUE(tenant_id, user_id, package_id, package_version, hook_name)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_hooks_lookup
                ON agent_lifecycle_hooks(event_type, phase, status, tenant_id, user_id, priority ASC, id ASC);
        `);
    }
}];
