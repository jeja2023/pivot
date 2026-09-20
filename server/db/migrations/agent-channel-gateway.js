'use strict';

/*
 * 双向消息 Gateway 的持久边界。
 *
 * 渠道身份配对、外部会话映射和入站事件去重均独立于 Agent Run，避免平台重试
 * 或进程重启把同一条外部消息转成重复任务。生产运行时是 PostgreSQL-only。
 */
const migration = {
    id: '202609200001_agent_channel_gateway',
    description: 'Add paired bidirectional channel sessions and durable inbound message idempotency.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_channel_pairings (
                id VARCHAR(128) PRIMARY KEY,
                binding_id VARCHAR(128) NOT NULL REFERENCES agent_channel_bindings(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tenant_id BIGINT,
                code_hash VARCHAR(128) NOT NULL UNIQUE,
                external_identity_hash VARCHAR(128) NOT NULL DEFAULT '',
                external_identity_hint VARCHAR(80) NOT NULL DEFAULT '',
                status VARCHAR(24) NOT NULL DEFAULT 'pending',
                expires_at TIMESTAMPTZ NOT NULL,
                paired_at TIMESTAMPTZ,
                revoked_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_agent_channel_pairings_binding_status
                ON agent_channel_pairings(binding_id, status, expires_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_channel_pairings_user
                ON agent_channel_pairings(user_id, status, updated_at DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_channel_pairings_active_identity
                ON agent_channel_pairings(binding_id, external_identity_hash)
                WHERE status = 'paired' AND external_identity_hash <> '';

            CREATE TABLE IF NOT EXISTS agent_channel_sessions (
                id VARCHAR(128) PRIMARY KEY,
                binding_id VARCHAR(128) NOT NULL REFERENCES agent_channel_bindings(id) ON DELETE CASCADE,
                pairing_id VARCHAR(128) NOT NULL REFERENCES agent_channel_pairings(id) ON DELETE RESTRICT,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tenant_id BIGINT,
                external_conversation_hash VARCHAR(128) NOT NULL,
                external_conversation_hint VARCHAR(80) NOT NULL DEFAULT '',
                session_id VARCHAR(128) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                status VARCHAR(24) NOT NULL DEFAULT 'active',
                last_inbound_at TIMESTAMPTZ,
                last_outbound_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(binding_id, external_conversation_hash)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_channel_sessions_user
                ON agent_channel_sessions(user_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_channel_sessions_pairing
                ON agent_channel_sessions(pairing_id, status, updated_at DESC);

            CREATE TABLE IF NOT EXISTS agent_channel_inbound_events (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                binding_id VARCHAR(128) NOT NULL REFERENCES agent_channel_bindings(id) ON DELETE CASCADE,
                channel_session_id VARCHAR(128) REFERENCES agent_channel_sessions(id) ON DELETE SET NULL,
                pairing_id VARCHAR(128) REFERENCES agent_channel_pairings(id) ON DELETE SET NULL,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tenant_id BIGINT,
                idempotency_key VARCHAR(255) NOT NULL,
                event_type VARCHAR(64) NOT NULL DEFAULT 'message',
                payload_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
                status VARCHAR(24) NOT NULL DEFAULT 'received',
                run_id VARCHAR(128) REFERENCES agent_runs(id) ON DELETE SET NULL,
                error_code VARCHAR(80) NOT NULL DEFAULT '',
                error_message TEXT NOT NULL DEFAULT '',
                received_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                processed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(binding_id, idempotency_key)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_channel_inbound_events_session
                ON agent_channel_inbound_events(channel_session_id, received_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_channel_inbound_events_user
                ON agent_channel_inbound_events(user_id, status, received_at DESC);
        `);
    }
};

module.exports = [migration];
