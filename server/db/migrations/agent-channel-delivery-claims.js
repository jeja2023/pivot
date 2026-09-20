module.exports = [
    {
        id: '202609080006_agent_channel_delivery_claims',
        description: 'Claim channel deliveries atomically and reclaim expired workers after process interruption.',
        async upPg(client) {
            await client.query(`
                ALTER TABLE agent_channel_deliveries ADD COLUMN IF NOT EXISTS claim_token VARCHAR(128);
                ALTER TABLE agent_channel_deliveries ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;
                CREATE INDEX IF NOT EXISTS idx_agent_channel_deliveries_claim_recovery
                    ON agent_channel_deliveries(status, claim_expires_at);
            `);
        }
    }
];
