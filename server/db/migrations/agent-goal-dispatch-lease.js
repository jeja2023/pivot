/**
 * PostgreSQL-only goal scheduler lease.
 *
 * A goal can be discovered by every application instance at the same minute.
 * The run dedupe key protects the final Agent Run, but it does not prevent all
 * instances from querying the source and doing duplicate work first. These
 * columns provide an explicit claim/fencing lease around one goal dispatch.
 */
const migration = {
    id: '202609050002_agent_goal_dispatch_lease',
    description: 'Add claim leases for multi-instance continuous goal dispatch.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_goals
                ADD COLUMN IF NOT EXISTS claim_token VARCHAR(128),
                ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;
            CREATE INDEX IF NOT EXISTS idx_agent_goals_claim
                ON agent_goals(status, next_run_at, claim_expires_at, updated_at);
        `);
    }
};

module.exports = [migration];
