const migration = {
    id: '202609070004_agent_step_unique_index',
    description: 'Repair duplicate Agent step numbers and enforce per-run step ordering.',
    async upPg(client) {
        await client.query(`
            WITH ranked AS (
                SELECT id, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY step_index ASC, id ASC) AS next_index
                FROM agent_steps
            )
            UPDATE agent_steps AS steps
            SET step_index = ranked.next_index
            FROM ranked
            WHERE steps.id = ranked.id;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_steps_run_step ON agent_steps(run_id, step_index);
        `);
    }
};

module.exports = [migration];
