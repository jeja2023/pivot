'use strict';

module.exports = [{
    id: '202610180003_agent_control_idempotency_keys',
    description: 'Deduplicate durable AgentControl deliveries across supervisor recovery and retries.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_control_messages
                ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_control_messages_idempotency
                ON agent_control_messages(user_id, to_run_id, idempotency_key)
                WHERE idempotency_key IS NOT NULL;
        `);
    }
}];
