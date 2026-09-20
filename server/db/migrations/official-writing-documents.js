const officialWritingDocumentsMigration = {
    id: '202609050001_official_writing_user_isolation',
    description: 'Persist official writing documents by owner to prevent cross-account browser storage exposure.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS official_writing_documents (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                client_id VARCHAR(96) NOT NULL,
                title VARCHAR(120) NOT NULL,
                manual_title BIGINT NOT NULL DEFAULT 0,
                state TEXT NOT NULL DEFAULT '{}',
                version BIGINT NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                deleted_at TIMESTAMPTZ,
                UNIQUE(user_id, client_id)
            );
            CREATE INDEX IF NOT EXISTS idx_official_writing_documents_user_updated
                ON official_writing_documents(user_id, deleted_at, updated_at DESC);
        `);
    }
};

module.exports = [officialWritingDocumentsMigration];
