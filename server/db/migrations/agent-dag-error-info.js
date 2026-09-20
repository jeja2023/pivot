'use strict';

const migration = {
    id: '202609190007_agent_dag_error_info',
    description: 'Persist structured DAG node failure diagnostics alongside the compatible error message.',
    async upPg(client) {
        await client.query("ALTER TABLE agent_dag_nodes ADD COLUMN IF NOT EXISTS error_info JSONB NOT NULL DEFAULT '{}'::jsonb");
    }
};

module.exports = [migration];
