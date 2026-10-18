'use strict';

const migration = {
    id: '202610170007_agent_working_memory_compaction_events',
    description: 'Allow a Working Memory compaction boundary to be recorded even when normalized state content is unchanged.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_working_memory_revisions
            DROP CONSTRAINT IF EXISTS agent_working_memory_revisions_run_id_state_hash_key;
            CREATE INDEX IF NOT EXISTS idx_agent_working_memory_revisions_state
                ON agent_working_memory_revisions(run_id, state_hash, revision DESC);
        `);
    }
};

module.exports = [migration];
