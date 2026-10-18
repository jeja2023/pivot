'use strict';

const migration = {
    id: '202610170006_agent_working_memory_revisions',
    description: 'Persist auditable Working Memory revisions and constraint-retention measurements per Agent run.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_working_memory_revisions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                run_id VARCHAR(160) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                revision INTEGER NOT NULL CHECK (revision > 0),
                reason VARCHAR(48) NOT NULL,
                state JSONB NOT NULL DEFAULT '{}'::jsonb,
                state_hash VARCHAR(64) NOT NULL,
                parent_state_hash VARCHAR(64) NOT NULL DEFAULT '',
                retention JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(run_id, revision),
                UNIQUE(run_id, state_hash)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_working_memory_revisions_run
                ON agent_working_memory_revisions(run_id, revision DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_working_memory_revisions_user
                ON agent_working_memory_revisions(user_id, created_at DESC);
        `);
    }
};

module.exports = [migration];
