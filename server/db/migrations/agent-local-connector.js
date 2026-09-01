/** 持久化桌面连接器：替代旧 local-device-bridge 的进程内 Map。 */
const migration = {
    id: '202609010003_agent_local_connector',
    description: 'Persist signed local desktop connector grants and task leases for read-only MCP operations.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_local_connector_grants (
                id VARCHAR(64) PRIMARY KEY,
                device_id VARCHAR(64) NOT NULL REFERENCES agent_local_devices(device_id) ON DELETE CASCADE,
                tenant_id BIGINT NOT NULL,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                grant_type VARCHAR(32) NOT NULL,
                path_hint VARCHAR(255) NOT NULL DEFAULT '',
                label VARCHAR(255) NOT NULL DEFAULT '',
                revoked_at TIMESTAMPTZ NULL,
                last_attested_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(device_id, grant_type)
            );
            CREATE INDEX IF NOT EXISTS idx_local_connector_grants_user ON agent_local_connector_grants(user_id, tenant_id, grant_type, revoked_at);

            CREATE TABLE IF NOT EXISTS agent_local_connector_tasks (
                id VARCHAR(64) PRIMARY KEY,
                tenant_id BIGINT NOT NULL,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                device_id VARCHAR(64) NOT NULL REFERENCES agent_local_devices(device_id) ON DELETE RESTRICT,
                grant_type VARCHAR(32) NOT NULL,
                tool_name VARCHAR(160) NOT NULL,
                input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                input_digest CHAR(64) NOT NULL,
                state VARCHAR(16) NOT NULL DEFAULT 'pending',
                attempt_count INTEGER NOT NULL DEFAULT 0,
                claim_token_hash CHAR(64) NULL,
                lease_expires_at TIMESTAMPTZ NULL,
                result_json JSONB NULL,
                failure_code VARCHAR(80) NULL,
                failure_reason TEXT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CHECK (state IN ('pending', 'claimed', 'completed', 'failed', 'expired'))
            );
            CREATE INDEX IF NOT EXISTS idx_local_connector_tasks_claim ON agent_local_connector_tasks(device_id, state, expires_at, created_at);
            CREATE INDEX IF NOT EXISTS idx_local_connector_tasks_user ON agent_local_connector_tasks(user_id, tenant_id, created_at DESC);
        `);
    },
    async downPg(client) {
        await client.query(`
            DROP TABLE IF EXISTS agent_local_connector_tasks;
            DROP TABLE IF EXISTS agent_local_connector_grants;
        `);
    }
};

const localBrowserConnectorMigration = {
    id: '202609010004_agent_local_browser_connector',
    description: 'Add metadata for local browser grants in the persistent desktop connector.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_local_connector_grants
            ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;
        `);
    },
    async downPg(client) {
        await client.query('ALTER TABLE agent_local_connector_grants DROP COLUMN IF EXISTS metadata_json;');
    }
};

module.exports = [migration, localBrowserConnectorMigration];
