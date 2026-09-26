module.exports = [{
    id: '202609260013_agent_goal_kinds',
    description: 'Differentiate scheduled jobs, silent monitors, and completion-oriented Agent goals.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_goals ADD COLUMN IF NOT EXISTS goal_kind VARCHAR(24) NOT NULL DEFAULT 'scheduled_job';
            ALTER TABLE agent_goals ADD COLUMN IF NOT EXISTS last_result_digest CHAR(64) NOT NULL DEFAULT '';
            CREATE INDEX IF NOT EXISTS idx_agent_goals_kind_status
                ON agent_goals(user_id, goal_kind, status, updated_at DESC);
        `);
    }
}];
