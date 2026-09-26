module.exports = [{
    id: '202609260010_agent_browser_sessions',
    description: 'Persist resumable browser-session ownership, page state, and expiry for controlled Agent browsing.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_browser_sessions (
                id VARCHAR(128) PRIMARY KEY,
                run_id VARCHAR(128) REFERENCES agent_runs(id) ON DELETE SET NULL,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tenant_id BIGINT NOT NULL,
                status VARCHAR(24) NOT NULL DEFAULT 'active',
                network_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
                current_url TEXT NOT NULL DEFAULT '',
                page_title VARCHAR(500) NOT NULL DEFAULT '',
                revision BIGINT NOT NULL DEFAULT 0,
                last_action VARCHAR(80) NOT NULL DEFAULT '',
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_agent_browser_sessions_owner
                ON agent_browser_sessions(user_id, status, expires_at);
            CREATE INDEX IF NOT EXISTS idx_agent_browser_sessions_run
                ON agent_browser_sessions(run_id, status, updated_at DESC);
        `);
    }
}];
