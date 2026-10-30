'use strict';

module.exports = [{
    id: '202610300001_agent_outbox_retention',
    description: 'Remember retired event deliveries so outbox cleanup preserves idempotency.',
    async upPg(client) {
        await client.query('ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS outbox_retired_at TIMESTAMPTZ');
    }
}];
