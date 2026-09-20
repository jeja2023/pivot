'use strict';

const migration = {
    id: '202609190006_agent_run_concurrency_leases',
    description: 'Enforce per-user Agent run concurrency across scheduler instances with expiring database leases.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_run_concurrency_leases (
                run_id VARCHAR(128) PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                lease_owner VARCHAR(128) NOT NULL,
                lease_expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_agent_run_concurrency_leases_user_expiry
                ON agent_run_concurrency_leases(user_id, lease_expires_at);
        `);
    }
};

module.exports = [migration];
