'use strict';

module.exports = [{
    id: '202610180001_agent_control_delivery_state_machine',
    description: 'Split AgentControl delivery, application and acknowledgement into durable recoverable states.',
    async upPg(client) {
        await client.query(`
            UPDATE agent_control_messages SET status = 'delivered'
            WHERE status = 'claimed';
            CREATE INDEX IF NOT EXISTS idx_agent_control_delivery_state
                ON agent_control_messages(to_run_id, status, applied_at, acknowledged_at, created_at);
        `);
    }
}];
