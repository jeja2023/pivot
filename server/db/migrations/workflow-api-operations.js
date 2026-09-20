'use strict';

const migration = {
    id: '202609190005_workflow_api_operations',
    description: 'Store governed OpenAPI-derived workflow API operations without storing secret values.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS workflow_api_operations (
                id VARCHAR(64) PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name VARCHAR(120) NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                operation_id VARCHAR(160) NOT NULL DEFAULT '',
                method VARCHAR(8) NOT NULL,
                base_url TEXT NOT NULL,
                path_template TEXT NOT NULL,
                parameter_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
                body_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
                response_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
                credential_slug VARCHAR(64) NOT NULL DEFAULT '',
                credential_header VARCHAR(80) NOT NULL DEFAULT 'Authorization',
                credential_prefix VARCHAR(80) NOT NULL DEFAULT 'Bearer ',
                side_effect BOOLEAN NOT NULL DEFAULT FALSE,
                idempotent BOOLEAN NOT NULL DEFAULT FALSE,
                status VARCHAR(24) NOT NULL DEFAULT 'active',
                source_digest VARCHAR(64) NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                deleted_at TIMESTAMPTZ,
                UNIQUE(user_id, name)
            );
            CREATE INDEX IF NOT EXISTS idx_workflow_api_operations_user ON workflow_api_operations(user_id, status, updated_at);
        `);
    }
};

module.exports = [migration];
