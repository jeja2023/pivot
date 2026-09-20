/** Personal learning loop and evolution artifact linkage. */
const migration = {
    id: '202609010005_agent_learning_loop',
    description: 'Add recoverable Agent learning jobs and bind evolution proposals to real artifacts.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_learning_jobs (
                id VARCHAR(128) PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tenant_id BIGINT,
                source_run_id VARCHAR(128) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                trigger_type VARCHAR(32) NOT NULL DEFAULT 'success',
                status VARCHAR(32) NOT NULL DEFAULT 'queued',
                attempts INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 3,
                next_run_at TIMESTAMPTZ,
                locked_at TIMESTAMPTZ,
                locked_by VARCHAR(128) DEFAULT '',
                model_id BIGINT REFERENCES models(id) ON DELETE SET NULL,
                budget_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
                result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
                error_code VARCHAR(80) DEFAULT '',
                error_message TEXT DEFAULT '',
                proposal_id VARCHAR(128) REFERENCES agent_evolution_proposals(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                completed_at TIMESTAMPTZ,
                UNIQUE(user_id, source_run_id, trigger_type)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_learning_jobs_claim ON agent_learning_jobs(status, next_run_at, id);
            CREATE INDEX IF NOT EXISTS idx_agent_learning_jobs_user ON agent_learning_jobs(user_id, status, updated_at);
            CREATE INDEX IF NOT EXISTS idx_agent_learning_jobs_source ON agent_learning_jobs(source_run_id, trigger_type);
            ALTER TABLE agent_evolution_proposals
                ADD COLUMN IF NOT EXISTS source_type VARCHAR(32) DEFAULT '',
                ADD COLUMN IF NOT EXISTS evidence_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
                ADD COLUMN IF NOT EXISTS artifact_type VARCHAR(32) DEFAULT '',
                ADD COLUMN IF NOT EXISTS artifact_id VARCHAR(160) DEFAULT '',
                ADD COLUMN IF NOT EXISTS artifact_version_id VARCHAR(160) DEFAULT '',
                ADD COLUMN IF NOT EXISTS release_id VARCHAR(160) DEFAULT '',
                ADD COLUMN IF NOT EXISTS scope VARCHAR(32) DEFAULT 'personal',
                ADD COLUMN IF NOT EXISTS activation_mode VARCHAR(32) DEFAULT 'user_confirmed',
                ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION DEFAULT 0,
                ADD COLUMN IF NOT EXISTS benefit_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
                ADD COLUMN IF NOT EXISTS review_reason TEXT DEFAULT '';
        `);
    }
};

module.exports = [migration];
