const migration = {
    id: '202609070004_agent_step_unique_index',
    description: 'Repair duplicate Agent step numbers and enforce per-run step ordering.',
    up(db) {
        const table = db.pragma('table_info(agent_steps)');
        if (!table.length) return;
        const runs = db.prepare('SELECT DISTINCT run_id FROM agent_steps').all();
        const select = db.prepare('SELECT id FROM agent_steps WHERE run_id = ? ORDER BY step_index ASC, id ASC');
        const update = db.prepare('UPDATE agent_steps SET step_index = ? WHERE id = ?');
        for (const run of runs) {
            select.all(run.run_id).forEach((row, index) => update.run(index + 1, row.id));
        }
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_steps_run_step ON agent_steps(run_id, step_index)');
    },
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
