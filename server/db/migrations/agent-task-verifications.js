module.exports = [{
    id: '202609260009_agent_task_verifications',
    description: 'Persist immutable-style task contract verification reports for every Agent completion path.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_verifications (
                id VARCHAR(128) PRIMARY KEY,
                run_id VARCHAR(128) NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                contract JSONB NOT NULL DEFAULT '{}'::jsonb,
                outcome_status VARCHAR(32) NOT NULL,
                report JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_agent_verifications_user_status
                ON agent_verifications(user_id, outcome_status, updated_at DESC);
        `);
    }
}];
