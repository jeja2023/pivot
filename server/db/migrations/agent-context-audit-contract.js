module.exports = [
    {
        id: '202609050003_agent_context_audit_contract',
        description: 'Persist one canonical AgentStepContext audit snapshot on tool calls.',
        async upPg(client) {
            await client.query(`
                ALTER TABLE agent_tool_calls
                    ADD COLUMN IF NOT EXISTS context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
                CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_context_snapshot_hash
                    ON agent_tool_calls ((context_snapshot->>'contextHash'));
            `);
        }
    }
];
