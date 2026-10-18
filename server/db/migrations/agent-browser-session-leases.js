'use strict';

module.exports = [{
    id: '202610180013_agent_browser_session_leases',
    description: 'Persist exclusive browser-session ownership with expiring fencing tokens.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_browser_session_leases (
                session_id VARCHAR(128) PRIMARY KEY REFERENCES agent_browser_sessions(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                owner_id VARCHAR(128) NOT NULL,
                lease_token UUID NOT NULL,
                lease_expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_agent_browser_session_leases_expiry
                ON agent_browser_session_leases(lease_expires_at);
        `);
    }
}];
