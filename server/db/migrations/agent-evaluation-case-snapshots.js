'use strict';

const migration = {
    id: '202609190003_agent_evaluation_case_snapshots',
    description: 'Freeze evaluation case inputs and assertions for each evaluation result.',
    async upPg(client) {
        await client.query("ALTER TABLE agent_eval_results ADD COLUMN IF NOT EXISTS case_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb");
    }
};

module.exports = [migration];
