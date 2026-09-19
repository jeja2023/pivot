'use strict';

const migration = {
    id: '202609190003_agent_evaluation_case_snapshots',
    description: 'Freeze evaluation case inputs and assertions for each evaluation result.',
    up(db) {
        const columns = db.pragma('table_info(agent_eval_results)');
        if (!columns.length) return;
        if (!columns.some(column => column.name === 'case_snapshot')) {
            db.exec("ALTER TABLE agent_eval_results ADD COLUMN case_snapshot TEXT DEFAULT '{}'");
        }
    },
    async upPg(client) {
        await client.query("ALTER TABLE agent_eval_results ADD COLUMN IF NOT EXISTS case_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb");
    }
};

module.exports = [migration];
