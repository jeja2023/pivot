'use strict';

module.exports = [{
    id: '202610170001_agent_execution_grants',
    description: 'Persist short-lived, single-use execution grants for enforced capability workers.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_execution_grants (
                grant_id UUID PRIMARY KEY,
                run_id VARCHAR(160) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tenant_id BIGINT NOT NULL DEFAULT 0,
                tool_name VARCHAR(160) NOT NULL,
                capability VARCHAR(120) NOT NULL,
                input_digest CHAR(64) NOT NULL,
                policy_snapshot CHAR(64) NOT NULL,
                workspace_scope VARCHAR(160) NOT NULL,
                network_mode VARCHAR(16) NOT NULL,
                token_digest CHAR(64) NOT NULL UNIQUE,
                claims JSONB NOT NULL,
                status VARCHAR(16) NOT NULL DEFAULT 'issued',
                issued_at TIMESTAMPTZ NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                consumed_at TIMESTAMPTZ NULL,
                consumer VARCHAR(160) NOT NULL DEFAULT '',
                revoked_at TIMESTAMPTZ NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CHECK (status IN ('issued', 'consumed', 'revoked', 'expired')),
                CHECK (expires_at > issued_at),
                CHECK ((status <> 'consumed') OR consumed_at IS NOT NULL)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_execution_grants_active
                ON agent_execution_grants(run_id, status, expires_at);
            CREATE INDEX IF NOT EXISTS idx_agent_execution_grants_user
                ON agent_execution_grants(user_id, tenant_id, created_at DESC);
        `);
    },
    async downPg(client) {
        await client.query('DROP TABLE IF EXISTS agent_execution_grants;');
    }
}];
