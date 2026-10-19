'use strict';

module.exports = [{
    id: '202610190001_agent_task_drafts',
    description: 'Persist reviewable chat task drafts and their immutable approval/run audit events before Agent execution.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_task_drafts (
                id VARCHAR(64) PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                session_id VARCHAR(128) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                title VARCHAR(160) NOT NULL,
                goal TEXT NOT NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'ready_for_review',
                revision INTEGER NOT NULL DEFAULT 1,
                plan_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                policy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
                plan_digest VARCHAR(64) NOT NULL,
                policy_digest VARCHAR(64) NOT NULL,
                approved_at TIMESTAMPTZ NULL,
                run_id VARCHAR(128) NULL REFERENCES agent_runs(id) ON DELETE SET NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CHECK (status IN ('needs_clarification', 'ready_for_review', 'approved', 'starting', 'run_created', 'cancelled', 'expired')),
                CHECK (revision > 0),
                CHECK (char_length(plan_digest) = 64),
                CHECK (char_length(policy_digest) = 64)
            );
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_agent_task_drafts_user_status_updated ON agent_task_drafts(user_id, status, updated_at DESC);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_agent_task_drafts_session_updated ON agent_task_drafts(session_id, updated_at DESC);');
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_task_draft_events (
                id VARCHAR(64) PRIMARY KEY,
                draft_id VARCHAR(64) NOT NULL REFERENCES agent_task_drafts(id) ON DELETE CASCADE,
                revision INTEGER NOT NULL,
                actor_user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
                event_type VARCHAR(48) NOT NULL,
                event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_agent_task_draft_events_draft_created ON agent_task_draft_events(draft_id, created_at ASC);');
    }
}];
