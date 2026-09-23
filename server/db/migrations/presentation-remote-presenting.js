'use strict';

const migration = {
    id: '202609230007_presentation_remote_presenting',
    description: 'Add short-lived remotely controlled presentation display sessions.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS presentation_remote_sessions (
                id VARCHAR(96) PRIMARY KEY,
                tenant_id BIGINT NOT NULL,
                presentation_id BIGINT NOT NULL REFERENCES presentation_documents(id) ON DELETE CASCADE,
                owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token_hash CHAR(64) NOT NULL UNIQUE,
                current_slide_index INTEGER NOT NULL DEFAULT 0,
                status VARCHAR(24) NOT NULL DEFAULT 'active',
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                closed_at TIMESTAMPTZ NULL,
                CONSTRAINT presentation_remote_session_status_check CHECK (status IN ('active', 'closed', 'expired'))
            );
            CREATE INDEX IF NOT EXISTS idx_presentation_remote_sessions_owner
                ON presentation_remote_sessions (tenant_id, owner_user_id, status, expires_at DESC);
        `);
    },
    async downPg(client) {
        await client.query(`
            DROP INDEX IF EXISTS idx_presentation_remote_sessions_owner;
            DROP TABLE IF EXISTS presentation_remote_sessions;
        `);
    }
};

module.exports = [migration];
