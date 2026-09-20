/** Personal Agent control plane schema. Kept separate from the historical migration ledger. */
const migrations = [{
    id: '202608240001_personal_agent_control_plane',
    description: 'Add governed personal Agent profiles, memory policy metadata, evolution proposals, and outcome feedback.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_profiles (
                user_id BIGINT PRIMARY KEY,
                profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                version INTEGER NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS agent_feedback (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL,
                run_id VARCHAR(128) NOT NULL,
                outcome VARCHAR(24) NOT NULL DEFAULT 'unknown',
                rating INTEGER,
                correction TEXT DEFAULT '',
                modified_answer TEXT DEFAULT '',
                tool_failures JSONB NOT NULL DEFAULT '[]'::jsonb,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                source VARCHAR(32) NOT NULL DEFAULT 'user',
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(user_id, run_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_agent_feedback_user_created ON agent_feedback(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_feedback_tool_failures ON agent_feedback(user_id, outcome, created_at DESC);
            CREATE TABLE IF NOT EXISTS agent_evolution_proposals (
                id VARCHAR(128) PRIMARY KEY,
                user_id BIGINT NOT NULL,
                kind VARCHAR(32) NOT NULL,
                title VARCHAR(255) NOT NULL,
                description TEXT DEFAULT '',
                proposed_change JSONB NOT NULL DEFAULT '{}'::jsonb,
                source_run_id VARCHAR(128),
                status VARCHAR(24) NOT NULL DEFAULT 'pending',
                version INTEGER NOT NULL DEFAULT 1,
                reviewed_by BIGINT,
                review_note TEXT DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                reviewed_at TIMESTAMPTZ,
                applied_at TIMESTAMPTZ,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (source_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL,
                FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS idx_agent_evolution_user_status ON agent_evolution_proposals(user_id, status, updated_at DESC);
            ALTER TABLE memories ADD COLUMN IF NOT EXISTS governance_class VARCHAR(24) DEFAULT 'fact';
            ALTER TABLE memories ADD COLUMN IF NOT EXISTS retention_mode VARCHAR(24) DEFAULT 'persistent';
            ALTER TABLE memories ADD COLUMN IF NOT EXISTS sensitive BOOLEAN NOT NULL DEFAULT FALSE;
            UPDATE memories SET governance_class = CASE WHEN type = 'preference' THEN 'preference' WHEN type = 'episode' THEN 'temporary' ELSE 'fact' END WHERE governance_class IS NULL OR governance_class = '';
        `);
    }
}];

module.exports = migrations;
