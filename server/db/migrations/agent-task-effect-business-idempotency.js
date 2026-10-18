'use strict';

module.exports = [{
    id: '202610180018_agent_task_effect_business_idempotency',
    description: 'Persist tenant-scoped business idempotency keys for cross-run external effect deduplication.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_task_effects ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL DEFAULT 0;
            UPDATE agent_task_effects e SET tenant_id = t.tenant_id
            FROM agent_task_transactions t WHERE t.id = e.transaction_id AND e.tenant_id = 0;
            CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_task_effects_business_idempotency
                ON agent_task_effects(tenant_id, effect_type, idempotency_key)
                WHERE idempotency_key LIKE 'business:%';
        `);
    }
}];
