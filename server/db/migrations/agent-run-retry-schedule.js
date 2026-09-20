module.exports = [
    {
        id: '202609080002_agent_run_retry_schedule',
        description: 'Persist delayed agent retry scheduling to prevent immediate retry storms.',
        async upPg(client) {
            await client.query(`
                ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS retry_after TIMESTAMPTZ;
                CREATE INDEX IF NOT EXISTS idx_agent_runs_retry_schedule ON agent_runs(status, retry_after, priority, created_at);
            `);
        }
    }
];
