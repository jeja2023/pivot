'use strict';

module.exports = [{
    id: '202610180016_agent_lifecycle_hook_packages',
    description: 'Persist signed immutable lifecycle Hook packages and bind managed hooks to their verified signing envelope.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_lifecycle_hook_packages (
                id UUID PRIMARY KEY,
                tenant_id BIGINT NOT NULL DEFAULT 0,
                package_id VARCHAR(160) NOT NULL,
                package_version VARCHAR(80) NOT NULL,
                manifest JSONB NOT NULL,
                manifest_digest VARCHAR(64) NOT NULL,
                signing_envelope_id BIGINT NOT NULL REFERENCES agent_skill_signing_envelopes(id) ON DELETE RESTRICT,
                signature_key_id VARCHAR(160) NOT NULL DEFAULT '',
                status VARCHAR(16) NOT NULL DEFAULT 'active',
                imported_by_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
                imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CHECK (status IN ('active', 'disabled', 'revoked')),
                UNIQUE(tenant_id, package_id, package_version),
                UNIQUE(tenant_id, manifest_digest)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_hook_packages_active
                ON agent_lifecycle_hook_packages(tenant_id, package_id, package_version, status);

            ALTER TABLE agent_lifecycle_hooks
                ADD COLUMN IF NOT EXISTS package_manifest_digest VARCHAR(64) NOT NULL DEFAULT '',
                ADD COLUMN IF NOT EXISTS signing_envelope_id BIGINT NULL REFERENCES agent_skill_signing_envelopes(id) ON DELETE RESTRICT;
            CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_hooks_package_manifest
                ON agent_lifecycle_hooks(tenant_id, package_id, package_version, package_manifest_digest);
        `);
    }
}];
