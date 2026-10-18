'use strict';

const migration = {
    id: '202610170005_agent_task_resource_leases',
    description: 'Add cross-run exclusive resource leases for staged Task Transaction effects.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_task_resource_leases (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                transaction_id UUID NOT NULL REFERENCES agent_task_transactions(id) ON DELETE CASCADE,
                effect_id UUID NOT NULL REFERENCES agent_task_effects(id) ON DELETE CASCADE,
                run_id VARCHAR(160) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                tenant_id BIGINT NOT NULL DEFAULT 0,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                resource_key VARCHAR(255) NOT NULL,
                lease_token UUID NOT NULL,
                mode VARCHAR(16) NOT NULL DEFAULT 'exclusive' CHECK (mode IN ('exclusive')),
                lease_expires_at TIMESTAMPTZ NOT NULL,
                released_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(transaction_id, effect_id, resource_key)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_task_resource_leases_active
                ON agent_task_resource_leases(resource_key, lease_expires_at)
                WHERE released_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_agent_task_resource_leases_transaction
                ON agent_task_resource_leases(transaction_id, released_at, lease_expires_at);
        `);
    }
};

module.exports = [migration];
