'use strict';

const migration = {
    id: '202609230005_presentation_library_features',
    description: 'Add tags and per-user favorites for searchable presentation libraries.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE presentation_documents ADD COLUMN IF NOT EXISTS tags_json TEXT NOT NULL DEFAULT '[]';
            CREATE TABLE IF NOT EXISTS presentation_document_favorites (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                tenant_id BIGINT NOT NULL,
                presentation_id BIGINT NOT NULL REFERENCES presentation_documents(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE (tenant_id, presentation_id, user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_presentation_documents_library_search
                ON presentation_documents (tenant_id, template_id, status, updated_at DESC)
                WHERE deleted_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_presentation_document_favorites_user
                ON presentation_document_favorites (tenant_id, user_id, created_at DESC);
        `);
    },
    async downPg(client) {
        await client.query(`
            DROP INDEX IF EXISTS idx_presentation_document_favorites_user;
            DROP INDEX IF EXISTS idx_presentation_documents_library_search;
            DROP TABLE IF EXISTS presentation_document_favorites;
            ALTER TABLE presentation_documents DROP COLUMN IF EXISTS tags_json;
        `);
    }
};

module.exports = [migration];
