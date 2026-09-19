'use strict';

const migration = {
    id: '202609190007_agent_dag_error_info',
    description: 'Persist structured DAG node failure diagnostics alongside the compatible error message.',
    up(db) {
        const columns = db.pragma('table_info(agent_dag_nodes)');
        if (columns.length && !columns.some(column => column.name === 'error_info')) {
            db.exec("ALTER TABLE agent_dag_nodes ADD COLUMN error_info TEXT DEFAULT '{}'");
        }
    },
    async upPg(client) {
        await client.query("ALTER TABLE agent_dag_nodes ADD COLUMN IF NOT EXISTS error_info JSONB NOT NULL DEFAULT '{}'::jsonb");
    }
};

module.exports = [migration];
