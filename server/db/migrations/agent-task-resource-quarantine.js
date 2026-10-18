'use strict';

module.exports = [{
    id: '202610180011_agent_task_resource_quarantine',
    description: 'Index resource history so unresolved task effects remain discoverable after a lease expires or is released.',
    async upPg(client) {
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_agent_task_resource_leases_resource_history
            ON agent_task_resource_leases(resource_key, transaction_id, effect_id);
            CREATE INDEX IF NOT EXISTS idx_agent_task_effects_resource_keys
            ON agent_task_effects USING GIN (resource_keys jsonb_path_ops);
        `);
    }
}];
