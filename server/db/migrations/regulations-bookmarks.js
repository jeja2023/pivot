'use strict';

module.exports = [{
    id: '202610120007_regulations_bookmarks',
    description: 'Add user-scoped regulation bookmarks and topic organization.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS regulation_bookmarks (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                document_id BIGINT NOT NULL REFERENCES regulation_documents(id) ON DELETE CASCADE,
                topic TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(user_id, document_id)
            );
            CREATE INDEX IF NOT EXISTS idx_regulation_bookmarks_user_topic
                ON regulation_bookmarks(user_id, topic, updated_at DESC);
        `);
    }
}];
