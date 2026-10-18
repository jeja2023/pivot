'use strict';

const migration = {
    id: '202610170008_agent_prompt_registry',
    description: 'Add versioned Prompt Section catalog and redacted per-run prompt invocation manifests.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_prompt_section_versions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                owner_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
                tenant_id BIGINT NOT NULL DEFAULT 0,
                section_key VARCHAR(120) NOT NULL,
                version VARCHAR(80) NOT NULL,
                owner VARCHAR(120) NOT NULL,
                stability VARCHAR(16) NOT NULL CHECK (stability IN ('stable', 'dynamic')),
                content_hash VARCHAR(64) NOT NULL,
                status VARCHAR(24) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(owner_user_id, section_key, version)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_prompt_sections_lookup
                ON agent_prompt_section_versions(tenant_id, section_key, status, updated_at DESC);

            CREATE TABLE IF NOT EXISTS agent_prompt_invocations (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                run_id VARCHAR(160) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                source VARCHAR(64) NOT NULL,
                prompt_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
                stable_digest VARCHAR(64) NOT NULL DEFAULT '',
                dynamic_digest VARCHAR(64) NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_agent_prompt_invocations_run
                ON agent_prompt_invocations(run_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_prompt_invocations_digest
                ON agent_prompt_invocations(stable_digest, created_at DESC);
        `);
    }
};

module.exports = [migration];
