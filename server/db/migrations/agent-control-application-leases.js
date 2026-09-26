module.exports = [{
    id: '202609260008_agent_control_application_leases',
    description: 'Lease claimed control messages and persist their atomic application to Agent runs.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_control_messages ADD COLUMN IF NOT EXISTS claim_token VARCHAR(128);
            ALTER TABLE agent_control_messages ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;
            ALTER TABLE agent_control_messages ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
            CREATE INDEX IF NOT EXISTS idx_agent_control_claim_recovery
                ON agent_control_messages(to_run_id, status, claim_expires_at, created_at);
            CREATE INDEX IF NOT EXISTS idx_agent_control_applied
                ON agent_control_messages(to_run_id, applied_at, id)
                WHERE applied_at IS NOT NULL;
        `);
    }
}];
