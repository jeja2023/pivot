'use strict';

const migration = {
    id: '202609190001_agent_dag_reuse_provenance',
    description: 'Persist the source run for DAG nodes reused by an explicit local rerun.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_dag_nodes ADD COLUMN IF NOT EXISTS reused_from_run_id VARCHAR(128);
            CREATE INDEX IF NOT EXISTS idx_agent_dag_nodes_reused_from_run ON agent_dag_nodes(reused_from_run_id);
        `);
    }
};

module.exports = [migration];
