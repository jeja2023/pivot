'use strict';

module.exports = [{
    id: '202608220009_chat_agent_run_message_link',
    description: 'Link assistant chat messages created by persistent Agent runs for idempotent recovery.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_run_id VARCHAR(128);
            CREATE INDEX IF NOT EXISTS idx_messages_agent_run ON messages(agent_run_id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_agent_run_unique
                ON messages(agent_run_id) WHERE agent_run_id IS NOT NULL;
        `);
    }
}];
