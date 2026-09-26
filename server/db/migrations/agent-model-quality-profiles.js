module.exports = [{
    id: '202609260011_agent_model_quality_profiles',
    description: 'Aggregate verified task outcomes by model and task type for quality-aware routing.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_model_quality_profiles (
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                model_id BIGINT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
                task_type VARCHAR(32) NOT NULL,
                sample_count BIGINT NOT NULL DEFAULT 0,
                verified_count BIGINT NOT NULL DEFAULT 0,
                partial_count BIGINT NOT NULL DEFAULT 0,
                failed_count BIGINT NOT NULL DEFAULT 0,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                PRIMARY KEY (user_id, model_id, task_type)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_model_quality_profiles_route
                ON agent_model_quality_profiles(user_id, task_type, sample_count DESC, updated_at DESC);
        `);
    }
}];
