'use strict';

const migration = {
    id: '202610170009_agent_browser_action_evidence',
    description: 'Persist redacted observe-before/act/observe-after evidence for controlled browser actions.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_browser_action_evidence (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                session_id VARCHAR(128) NOT NULL REFERENCES agent_browser_sessions(id) ON DELETE CASCADE,
                run_id VARCHAR(160) REFERENCES agent_runs(id) ON DELETE SET NULL,
                transaction_id UUID REFERENCES agent_task_transactions(id) ON DELETE SET NULL,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                action VARCHAR(32) NOT NULL,
                tab_id VARCHAR(80) NOT NULL DEFAULT '',
                before_state JSONB NOT NULL DEFAULT '{}'::jsonb,
                after_state JSONB NOT NULL DEFAULT '{}'::jsonb,
                outcome JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_agent_browser_action_evidence_run
                ON agent_browser_action_evidence(run_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_browser_action_evidence_transaction
                ON agent_browser_action_evidence(transaction_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_browser_action_evidence_session
                ON agent_browser_action_evidence(session_id, created_at ASC);
        `);
    }
};

module.exports = [migration];
