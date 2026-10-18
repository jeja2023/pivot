'use strict';

module.exports = [{
    id: '202610180002_agent_task_resource_conflicts',
    description: 'Persist explainable cross-run task resource lease conflicts for collaboration recovery.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_task_resource_conflicts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                resource_key VARCHAR(255) NOT NULL,
                requester_transaction_id UUID NOT NULL REFERENCES agent_task_transactions(id) ON DELETE CASCADE,
                requester_run_id VARCHAR(160) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                holder_transaction_id UUID NOT NULL REFERENCES agent_task_transactions(id) ON DELETE CASCADE,
                holder_effect_id UUID NOT NULL REFERENCES agent_task_effects(id) ON DELETE CASCADE,
                holder_run_id VARCHAR(160) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                observed_lease_expires_at TIMESTAMPTZ,
                status VARCHAR(24) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'released', 'resolved')),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                resolved_at TIMESTAMPTZ
            );
            CREATE INDEX IF NOT EXISTS idx_agent_task_resource_conflicts_requester
                ON agent_task_resource_conflicts(requester_transaction_id, status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_task_resource_conflicts_holder
                ON agent_task_resource_conflicts(holder_transaction_id, status, created_at DESC);
        `);
    }
}];
