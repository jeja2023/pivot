module.exports = [{
    id: '202609260012_agent_shared_tool_guard',
    description: 'Enforce per-tool concurrency across application instances with expiring PostgreSQL leases.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_tool_execution_leases (
                lease_token VARCHAR(128) PRIMARY KEY,
                guard_key VARCHAR(400) NOT NULL,
                tool_name VARCHAR(320) NOT NULL,
                connection_account_id BIGINT,
                server_id BIGINT,
                lease_expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_agent_tool_execution_leases_guard
                ON agent_tool_execution_leases(guard_key, lease_expires_at);
        `);
    }
}];
