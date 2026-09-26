module.exports = [{
    id: '202609260016_agent_voice_sessions',
    description: 'Persist privacy-bounded realtime voice session lifecycle and interruption audits without recording audio or transcripts.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_voice_sessions (
                id VARCHAR(128) PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                session_id VARCHAR(128) REFERENCES sessions(id) ON DELETE SET NULL,
                transport VARCHAR(40) NOT NULL,
                language VARCHAR(32) NOT NULL DEFAULT 'zh-CN',
                status VARCHAR(24) NOT NULL DEFAULT 'active',
                turn_count INTEGER NOT NULL DEFAULT 0,
                barge_in_count INTEGER NOT NULL DEFAULT 0,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                started_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                ended_at TIMESTAMPTZ,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_agent_voice_sessions_user_active
                ON agent_voice_sessions(user_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_voice_sessions_session
                ON agent_voice_sessions(session_id, updated_at DESC);
        `);
    }
}];
