/**
 * PostgreSQL-only control-plane additions for the personal Agent experience.
 * The runtime has already moved to PostgreSQL; this migration intentionally
 * exposes no SQLite implementation.
 */
const migration = {
    id: '202608240002_personal_agent_control_plane_v2',
    description: 'Add governed Agent goals, channels, evolution validations and tool reliability signals.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_goals (
                id VARCHAR(128) PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tenant_id BIGINT,
                title VARCHAR(160) NOT NULL,
                goal TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 0,
                status VARCHAR(24) NOT NULL DEFAULT 'active',
                trigger_spec JSONB NOT NULL DEFAULT '{}'::jsonb,
                authorization_spec JSONB NOT NULL DEFAULT '{}'::jsonb,
                budget_spec JSONB NOT NULL DEFAULT '{}'::jsonb,
                cooldown_seconds INTEGER NOT NULL DEFAULT 300,
                max_failures INTEGER NOT NULL DEFAULT 5,
                failure_count INTEGER NOT NULL DEFAULT 0,
                next_run_at TIMESTAMPTZ,
                last_run_id VARCHAR(128),
                last_trigger_key VARCHAR(256),
                last_error TEXT DEFAULT '',
                version INTEGER NOT NULL DEFAULT 1,
                paused_at TIMESTAMPTZ,
                ended_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_agent_goals_due
                ON agent_goals(status, next_run_at, updated_at);
            CREATE INDEX IF NOT EXISTS idx_agent_goals_user
                ON agent_goals(user_id, status, updated_at DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_goals_trigger_key
                ON agent_goals(id, last_trigger_key);

            CREATE TABLE IF NOT EXISTS agent_profile_versions (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                version INTEGER NOT NULL,
                profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                source VARCHAR(32) NOT NULL DEFAULT 'user',
                changed_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(user_id, version)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_profile_versions_user
                ON agent_profile_versions(user_id, version DESC);

            CREATE TABLE IF NOT EXISTS agent_memory_policy_versions (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                version INTEGER NOT NULL,
                policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                effective_at TIMESTAMPTZ NOT NULL,
                changed_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(user_id, version)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_memory_policy_versions_user
                ON agent_memory_policy_versions(user_id, version DESC);

            CREATE TABLE IF NOT EXISTS agent_channel_bindings (
                id VARCHAR(128) PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tenant_id BIGINT,
                channel_type VARCHAR(32) NOT NULL,
                channel_key VARCHAR(160) NOT NULL,
                credential_ref VARCHAR(255) NOT NULL DEFAULT '',
                config JSONB NOT NULL DEFAULT '{}'::jsonb,
                notification_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
                status VARCHAR(24) NOT NULL DEFAULT 'active',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(user_id, channel_type, channel_key)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_channel_bindings_user
                ON agent_channel_bindings(user_id, status, updated_at DESC);

            CREATE TABLE IF NOT EXISTS agent_evolution_validations (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                proposal_id VARCHAR(128) NOT NULL REFERENCES agent_evolution_proposals(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                stage VARCHAR(32) NOT NULL DEFAULT 'static',
                status VARCHAR(32) NOT NULL DEFAULT 'running',
                static_result JSONB NOT NULL DEFAULT '{}'::jsonb,
                sandbox_result JSONB NOT NULL DEFAULT '{}'::jsonb,
                evaluation_result JSONB NOT NULL DEFAULT '{}'::jsonb,
                risk_level VARCHAR(16) NOT NULL DEFAULT 'low',
                permission_diff JSONB NOT NULL DEFAULT '{}'::jsonb,
                test_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
                rollback_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
                version INTEGER NOT NULL DEFAULT 1,
                error_code VARCHAR(64) DEFAULT '',
                error_message TEXT DEFAULT '',
                validated_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_agent_evolution_validations_proposal
                ON agent_evolution_validations(proposal_id, version DESC, created_at DESC);

            CREATE TABLE IF NOT EXISTS agent_tool_reliability (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
                tenant_id BIGINT,
                tool_name VARCHAR(160) NOT NULL,
                tool_version VARCHAR(64) NOT NULL DEFAULT '',
                task_type VARCHAR(160) NOT NULL DEFAULT '',
                window_start TIMESTAMPTZ NOT NULL,
                window_end TIMESTAMPTZ NOT NULL,
                sample_count INTEGER NOT NULL DEFAULT 0,
                success_count INTEGER NOT NULL DEFAULT 0,
                timeout_count INTEGER NOT NULL DEFAULT 0,
                helpful_count INTEGER NOT NULL DEFAULT 0,
                schema_valid_count INTEGER NOT NULL DEFAULT 0,
                success_rate NUMERIC(8,5) NOT NULL DEFAULT 0,
                timeout_rate NUMERIC(8,5) NOT NULL DEFAULT 0,
                helpful_rate NUMERIC(8,5) NOT NULL DEFAULT 0,
                schema_valid_rate NUMERIC(8,5) NOT NULL DEFAULT 0,
                score NUMERIC(8,5) NOT NULL DEFAULT 0,
                confidence NUMERIC(8,5) NOT NULL DEFAULT 0,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_agent_tool_reliability_lookup
                ON agent_tool_reliability(user_id, tool_name, task_type, window_end DESC);

            ALTER TABLE agent_evolution_proposals
                ADD COLUMN IF NOT EXISTS risk_level VARCHAR(16) NOT NULL DEFAULT 'low',
                ADD COLUMN IF NOT EXISTS permission_diff JSONB NOT NULL DEFAULT '{}'::jsonb,
                ADD COLUMN IF NOT EXISTS test_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
                ADD COLUMN IF NOT EXISTS rollback_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
                ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
                ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMPTZ,
                ADD COLUMN IF NOT EXISTS rollback_target_id VARCHAR(128),
                ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);
            ALTER TABLE agent_notifications
                ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ,
                ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_evolution_proposals_idempotency
                ON agent_evolution_proposals(user_id, idempotency_key)
                WHERE idempotency_key IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_user_dedupe_control_plane
                ON agent_runs(user_id, dedupe_key)
                WHERE dedupe_key IS NOT NULL AND deleted_at IS NULL;
        `);
    }
};

module.exports = [migration];
