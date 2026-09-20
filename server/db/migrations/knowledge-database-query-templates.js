'use strict';

const migration = {
    id: '202609200006_knowledge_database_query_templates',
    description: 'Require approved read-only query templates for database knowledge sources.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS knowledge_database_query_templates (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                connection_id TEXT NOT NULL,
                name TEXT NOT NULL,
                sql_template TEXT NOT NULL,
                title_field TEXT NOT NULL DEFAULT 'title',
                content_field TEXT NOT NULL DEFAULT 'content',
                watermark_field TEXT NOT NULL DEFAULT 'updated_at',
                status TEXT NOT NULL DEFAULT 'draft',
                approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                approved_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_knowledge_database_templates_connection_status
                ON knowledge_database_query_templates(connection_id, status, updated_at DESC);
        `);
    }
};

module.exports = [migration];
