'use strict';

// PostgreSQL Agent 运行时基础迁移（从历史总表机械提取，不含 SQLite 分支）。
module.exports = [
{
id: '202608210001_autonomous_agent_runtime_contracts',
description: 'Add autonomous Agent budget, tool governance audit, and Skill registry contracts.',
async upPg(client) {
            await client.query(`
                ALTER TABLE agent_runs
                    ADD COLUMN IF NOT EXISTS budget_config JSONB DEFAULT '{}'::jsonb,
                    ADD COLUMN IF NOT EXISTS usage_stats JSONB DEFAULT '{}'::jsonb;
                CREATE TABLE IF NOT EXISTS agent_tool_calls (
                    id VARCHAR(64) PRIMARY KEY,
                    run_id VARCHAR(64) NOT NULL,
                    step_id VARCHAR(64) NOT NULL,
                    tool_name VARCHAR(128) NOT NULL,
                    capability VARCHAR(128) DEFAULT 'agent.execute',
                    risk_level INTEGER DEFAULT 0,
                    policy_decision VARCHAR(32) NOT NULL,
                    policy_version VARCHAR(32) DEFAULT 'v1',
                    approval_id VARCHAR(64),
                    idempotent BOOLEAN DEFAULT FALSE,
                    input_payload JSONB DEFAULT '{}'::jsonb,
                    input_hash VARCHAR(64),
                    output_payload_ref TEXT,
                    output_hash VARCHAR(64),
                    status VARCHAR(32) NOT NULL,
                    error_category VARCHAR(32),
                    error_message TEXT,
                    duration_ms INTEGER DEFAULT 0,
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
                );
                CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_run ON agent_tool_calls(run_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_tool ON agent_tool_calls(tool_name);
                CREATE TABLE IF NOT EXISTS agent_skills (
                    id VARCHAR(64) PRIMARY KEY,
                    name VARCHAR(128) NOT NULL,
                    version VARCHAR(32) NOT NULL,
                    title VARCHAR(255) NOT NULL,
                    description TEXT DEFAULT '',
                    publisher VARCHAR(128) DEFAULT '',
                    digest VARCHAR(64) NOT NULL,
                    manifest_yaml TEXT NOT NULL,
                    instructions_md TEXT DEFAULT '',
                    scope VARCHAR(32) DEFAULT 'user',
                    user_id VARCHAR(64),
                    status VARCHAR(32) DEFAULT 'enabled',
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
                );
                CREATE INDEX IF NOT EXISTS idx_agent_skills_user ON agent_skills(user_id, status, updated_at);
                COMMENT ON TABLE agent_tool_calls IS '智能体工具调用治理与执行审计表';
                COMMENT ON TABLE agent_skills IS '企业级 Skill 清单与供应链校验登记表';
            `);
        }
},
{
id: '202608210002_agent_execution_ledger',
description: 'Add idempotent tool execution ledger, network policy persistence, and Skill tenant ownership.',
async upPg(client) {
            await client.query(`
                ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS network_policy JSONB DEFAULT '{}'::jsonb;
                CREATE TABLE IF NOT EXISTS agent_run_checkpoints (
                    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    checkpoint_id VARCHAR(128) NOT NULL UNIQUE,
                    run_id VARCHAR(128) NOT NULL,
                    step_index INTEGER DEFAULT 0,
                    checkpoint_type VARCHAR(32) DEFAULT 'step',
                    status VARCHAR(32) DEFAULT 'completed',
                    state JSONB NOT NULL DEFAULT '{}'::jsonb,
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
                );
                ALTER TABLE agent_run_checkpoints ADD COLUMN IF NOT EXISTS operation_key VARCHAR(255);
                ALTER TABLE agent_run_checkpoints ADD COLUMN IF NOT EXISTS tool_name VARCHAR(128) DEFAULT '';
                ALTER TABLE agent_run_checkpoints ADD COLUMN IF NOT EXISTS input_hash VARCHAR(64) DEFAULT '';
                ALTER TABLE agent_run_checkpoints ADD COLUMN IF NOT EXISTS idempotent BOOLEAN DEFAULT FALSE;
                ALTER TABLE agent_run_checkpoints ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ;
                ALTER TABLE agent_run_checkpoints ADD COLUMN IF NOT EXISTS attempt INTEGER DEFAULT 1;
                CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_checkpoints_operation_key ON agent_run_checkpoints(operation_key) WHERE operation_key IS NOT NULL;
                ALTER TABLE agent_skills DROP CONSTRAINT IF EXISTS agent_skills_name_key;
                UPDATE agent_skills SET user_id = NULL WHERE user_id IS NOT NULL AND TRIM(user_id) !~ '^[0-9]+$';
                ALTER TABLE agent_skills ALTER COLUMN user_id TYPE BIGINT USING NULLIF(TRIM(user_id), '')::bigint;
                ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS owner_key VARCHAR(255) DEFAULT '';
                UPDATE agent_skills SET owner_key = CASE WHEN scope IN ('global', 'shared') THEN 'scope:' || scope ELSE 'user:' || COALESCE(user_id::text, '') END WHERE owner_key IS NULL OR owner_key = '';
                CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_skills_owner_name ON agent_skills(owner_key, name);
                DO $$ BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_skills_user_id_fkey') THEN
                        ALTER TABLE agent_skills ADD CONSTRAINT agent_skills_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
                    END IF;
                END $$;
                DO $$ BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_tool_calls_run_id_fkey') THEN
                        ALTER TABLE agent_tool_calls ADD CONSTRAINT agent_tool_calls_run_id_fkey FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE;
                    END IF;
                END $$;
                ALTER TABLE agent_tool_calls ADD COLUMN IF NOT EXISTS attempt INTEGER DEFAULT 1;
                ALTER TABLE agent_tool_calls ADD COLUMN IF NOT EXISTS operation_key VARCHAR(255);
                CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_operation ON agent_tool_calls(operation_key);
                CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_input_gin ON agent_tool_calls USING gin(input_payload);
            `);
        }
},
{
id: '202608210003_agent_harness_context_events',
description: 'Add PostgreSQL AgentStepContext hashes, WorldState event sequencing, and append-only Agent events.',
async upPg(client) {
            await client.query(`
                ALTER TABLE agent_runs
                    ADD COLUMN IF NOT EXISTS event_seq BIGINT NOT NULL DEFAULT 0;
                ALTER TABLE agent_steps
                    ADD COLUMN IF NOT EXISTS context_hash VARCHAR(64) DEFAULT '';
                ALTER TABLE agent_trace_spans
                    ADD COLUMN IF NOT EXISTS context_hash VARCHAR(64) DEFAULT '';
                ALTER TABLE agent_tool_calls
                    ADD COLUMN IF NOT EXISTS context_hash VARCHAR(64) DEFAULT '';
                CREATE TABLE IF NOT EXISTS agent_events (
                    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    run_id VARCHAR(128) NOT NULL,
                    user_id BIGINT NOT NULL,
                    event_seq BIGINT NOT NULL,
                    event_key VARCHAR(255) DEFAULT '',
                    event_type VARCHAR(80) NOT NULL,
                    turn_id VARCHAR(160) DEFAULT '',
                    step_index INTEGER DEFAULT 0,
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    payload_hash VARCHAR(64) NOT NULL,
                    provider_visible BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    UNIQUE(run_id, event_seq),
                    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_agent_events_run_seq ON agent_events(run_id, event_seq);
                CREATE INDEX IF NOT EXISTS idx_agent_events_user_seq ON agent_events(user_id, event_seq);
                CREATE INDEX IF NOT EXISTS idx_agent_events_type ON agent_events(event_type, created_at);
                CREATE INDEX IF NOT EXISTS idx_agent_steps_context_hash ON agent_steps(context_hash);
                CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_context_hash ON agent_trace_spans(context_hash);
                CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_context_hash ON agent_tool_calls(context_hash);
            `);
        }
},
{
id: '202608220001_agent_control_mailbox',
description: 'Add PostgreSQL parent-child AgentControl mailbox with scoped delivery and acknowledgements.',
async upPg(client) {
            await client.query(`
                CREATE TABLE IF NOT EXISTS agent_control_messages (
                    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    message_id VARCHAR(128) NOT NULL UNIQUE,
                    user_id BIGINT NOT NULL,
                    from_run_id VARCHAR(128),
                    to_run_id VARCHAR(128) NOT NULL,
                    message_type VARCHAR(40) NOT NULL DEFAULT 'steer',
                    status VARCHAR(24) NOT NULL DEFAULT 'pending',
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    payload_hash VARCHAR(64) NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    delivered_at TIMESTAMPTZ,
                    acknowledged_at TIMESTAMPTZ,
                    expires_at TIMESTAMPTZ,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (from_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY (to_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_agent_control_to_status ON agent_control_messages(to_run_id, status, created_at);
                CREATE INDEX IF NOT EXISTS idx_agent_control_user_created ON agent_control_messages(user_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_agent_control_from_run ON agent_control_messages(from_run_id, created_at);
            `);
        }
},
{
id: '202608220002_agent_world_state_windows',
description: 'Persist PostgreSQL WorldState context windows, baselines, and replayable snapshots for Agent runs.',
async upPg(client) {
            await client.query(`
                CREATE TABLE IF NOT EXISTS agent_context_windows (
                    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    window_id VARCHAR(128) NOT NULL UNIQUE,
                    run_id VARCHAR(128) NOT NULL,
                    user_id BIGINT NOT NULL,
                    window_version INTEGER NOT NULL,
                    parent_window_id VARCHAR(128),
                    status VARCHAR(24) NOT NULL DEFAULT 'active',
                    opened_reason VARCHAR(64) NOT NULL DEFAULT 'initial',
                    initial_state_hash VARCHAR(64) NOT NULL DEFAULT '',
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    closed_at TIMESTAMPTZ,
                    UNIQUE(run_id, window_version),
                    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS agent_world_state_snapshots (
                    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    snapshot_id VARCHAR(128) NOT NULL UNIQUE,
                    run_id VARCHAR(128) NOT NULL,
                    user_id BIGINT NOT NULL,
                    window_id VARCHAR(128) NOT NULL,
                    snapshot_version INTEGER NOT NULL,
                    turn_id VARCHAR(160) DEFAULT '',
                    step_index INTEGER DEFAULT 0,
                    context_hash VARCHAR(64) NOT NULL DEFAULT '',
                    state_hash VARCHAR(64) NOT NULL,
                    base_state_hash VARCHAR(64) DEFAULT '',
                    injection_mode VARCHAR(16) NOT NULL DEFAULT 'full',
                    full_refresh_reason VARCHAR(64) DEFAULT '',
                    state JSONB NOT NULL DEFAULT '{}'::jsonb,
                    patch JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    UNIQUE(run_id, snapshot_version),
                    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (window_id) REFERENCES agent_context_windows(window_id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_agent_context_windows_run_version
                    ON agent_context_windows(run_id, window_version DESC);
                CREATE INDEX IF NOT EXISTS idx_agent_context_windows_user_created
                    ON agent_context_windows(user_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_agent_world_state_run_version
                    ON agent_world_state_snapshots(run_id, snapshot_version DESC);
                CREATE INDEX IF NOT EXISTS idx_agent_world_state_window_version
                    ON agent_world_state_snapshots(window_id, snapshot_version ASC);
                CREATE INDEX IF NOT EXISTS idx_agent_world_state_context_hash
                    ON agent_world_state_snapshots(context_hash);
            `);
        }
},
{
id: '202608220003_agent_event_outbox',
description: 'Persist PostgreSQL Agent event notifications for retryable cross-process delivery and replay cursors.',
async upPg(client) {
            await client.query(`
                CREATE TABLE IF NOT EXISTS agent_event_outbox (
                    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    event_id BIGINT NOT NULL UNIQUE,
                    run_id VARCHAR(128) NOT NULL,
                    user_id BIGINT NOT NULL,
                    event_seq BIGINT NOT NULL,
                    event_type VARCHAR(80) NOT NULL,
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    status VARCHAR(24) NOT NULL DEFAULT 'pending',
                    delivery_attempts INTEGER NOT NULL DEFAULT 0,
                    available_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    locked_at TIMESTAMPTZ,
                    locked_by VARCHAR(128) DEFAULT '',
                    delivered_at TIMESTAMPTZ,
                    last_error TEXT DEFAULT '',
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    FOREIGN KEY (event_id) REFERENCES agent_events(id) ON DELETE CASCADE,
                    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_agent_event_outbox_pending
                    ON agent_event_outbox(status, available_at, id);
                CREATE INDEX IF NOT EXISTS idx_agent_event_outbox_run_seq
                    ON agent_event_outbox(run_id, event_seq);
                CREATE INDEX IF NOT EXISTS idx_agent_event_outbox_user_status
                    ON agent_event_outbox(user_id, status, created_at);
            `);
        }
},
{
id: '202608220004_agent_run_resources',
description: 'Track PostgreSQL Agent child budget reservations, concurrency limits, and fork history policy.',
async upPg(client) {
            await client.query(`
                CREATE TABLE IF NOT EXISTS agent_run_resources (
                    run_id VARCHAR(128) PRIMARY KEY,
                    user_id BIGINT NOT NULL,
                    parent_run_id VARCHAR(128),
                    token_budget BIGINT NOT NULL DEFAULT 0,
                    tokens_reserved BIGINT NOT NULL DEFAULT 0,
                    tokens_consumed BIGINT NOT NULL DEFAULT 0,
                    max_children INTEGER NOT NULL DEFAULT 4,
                    active_children INTEGER NOT NULL DEFAULT 0,
                    fork_history_mode VARCHAR(16) NOT NULL DEFAULT 'none',
                    fork_history_turns INTEGER NOT NULL DEFAULT 0,
                    reservation_released BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (parent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_agent_run_resources_parent
                    ON agent_run_resources(parent_run_id, reservation_released);
                CREATE INDEX IF NOT EXISTS idx_agent_run_resources_user
                    ON agent_run_resources(user_id, created_at DESC);
            `);
        }
},
{
id: '202608220005_chat_context_windows',
description: 'Persist PostgreSQL Chat context windows and compact world-state snapshots for cross-entry replay.',
async upPg(client) {
            await client.query(`
                CREATE TABLE IF NOT EXISTS chat_context_windows (
                    window_id VARCHAR(128) PRIMARY KEY,
                    session_id VARCHAR(128) NOT NULL,
                    user_id BIGINT NOT NULL,
                    window_version INTEGER NOT NULL,
                    parent_window_id VARCHAR(128),
                    status VARCHAR(24) NOT NULL DEFAULT 'active',
                    opened_reason VARCHAR(64) NOT NULL DEFAULT 'initial',
                    initial_state_hash VARCHAR(64) NOT NULL DEFAULT '',
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    closed_at TIMESTAMPTZ,
                    UNIQUE(session_id, user_id, window_version),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS chat_context_snapshots (
                    snapshot_id VARCHAR(128) PRIMARY KEY,
                    session_id VARCHAR(128) NOT NULL,
                    user_id BIGINT NOT NULL,
                    window_id VARCHAR(128) NOT NULL,
                    snapshot_version INTEGER NOT NULL,
                    turn_id VARCHAR(160) NOT NULL DEFAULT '',
                    context_hash VARCHAR(64) NOT NULL DEFAULT '',
                    state_hash VARCHAR(64) NOT NULL,
                    base_state_hash VARCHAR(64) NOT NULL DEFAULT '',
                    injection_mode VARCHAR(16) NOT NULL DEFAULT 'full',
                    full_refresh_reason VARCHAR(64) NOT NULL DEFAULT '',
                    state JSONB NOT NULL DEFAULT '{}'::jsonb,
                    patch JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    UNIQUE(session_id, user_id, snapshot_version),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (window_id) REFERENCES chat_context_windows(window_id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_chat_context_windows_session
                    ON chat_context_windows(session_id, user_id, window_version DESC);
                CREATE INDEX IF NOT EXISTS idx_chat_context_snapshots_session
                    ON chat_context_snapshots(session_id, user_id, snapshot_version DESC);
                CREATE INDEX IF NOT EXISTS idx_chat_context_snapshots_hash
                    ON chat_context_snapshots(context_hash);
            `);
        }
},
{
id: '202608220006_agent_residency',
description: 'Persist PostgreSQL resident Agent state with leases, expiry and per-user LRU eviction.',
async upPg(client) {
            await client.query(`
                CREATE TABLE IF NOT EXISTS agent_residencies (
                    resident_id VARCHAR(128) PRIMARY KEY,
                    user_id BIGINT NOT NULL,
                    resident_key VARCHAR(255) NOT NULL,
                    run_id VARCHAR(128),
                    status VARCHAR(24) NOT NULL DEFAULT 'idle',
                    state JSONB NOT NULL DEFAULT '{}'::jsonb,
                    context_hash VARCHAR(64) NOT NULL DEFAULT '',
                    last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    expires_at TIMESTAMPTZ,
                    lease_owner VARCHAR(128) NOT NULL DEFAULT '',
                    lease_expires_at TIMESTAMPTZ,
                    hit_count BIGINT NOT NULL DEFAULT 0,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    UNIQUE(user_id, resident_key),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
                );
                CREATE INDEX IF NOT EXISTS idx_agent_residencies_user_access
                    ON agent_residencies(user_id, status, last_accessed_at ASC);
                CREATE INDEX IF NOT EXISTS idx_agent_residencies_expiry
                    ON agent_residencies(status, expires_at, lease_expires_at);
                CREATE INDEX IF NOT EXISTS idx_agent_residencies_run
                    ON agent_residencies(run_id, updated_at DESC);
            `);
        }
},
{
id: '202608220007_provider_usage_calibration',
description: 'Persist real Provider usage samples and aggregate estimate error metrics per model and protocol.',
async upPg(client) {
            await client.query(`
                CREATE TABLE IF NOT EXISTS model_usage_calibrations (
                    model_id BIGINT NOT NULL,
                    protocol VARCHAR(32) NOT NULL DEFAULT 'unknown',
                    sample_count BIGINT NOT NULL DEFAULT 0,
                    input_sample_count BIGINT NOT NULL DEFAULT 0,
                    output_sample_count BIGINT NOT NULL DEFAULT 0,
                    estimated_input_tokens BIGINT NOT NULL DEFAULT 0,
                    actual_input_tokens BIGINT NOT NULL DEFAULT 0,
                    input_abs_error_tokens BIGINT NOT NULL DEFAULT 0,
                    input_signed_error_tokens BIGINT NOT NULL DEFAULT 0,
                    max_input_abs_error_tokens BIGINT NOT NULL DEFAULT 0,
                    estimated_output_tokens BIGINT NOT NULL DEFAULT 0,
                    actual_output_tokens BIGINT NOT NULL DEFAULT 0,
                    output_abs_error_tokens BIGINT NOT NULL DEFAULT 0,
                    output_signed_error_tokens BIGINT NOT NULL DEFAULT 0,
                    max_output_abs_error_tokens BIGINT NOT NULL DEFAULT 0,
                    last_actual_total_tokens BIGINT NOT NULL DEFAULT 0,
                    last_source VARCHAR(80) NOT NULL DEFAULT '',
                    last_sample_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    PRIMARY KEY (model_id, protocol)
                );
                CREATE INDEX IF NOT EXISTS idx_model_usage_calibrations_updated
                    ON model_usage_calibrations(updated_at DESC);
            `);
        }
}
];
