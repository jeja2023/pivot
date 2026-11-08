'use strict';

const tables = [
    `CREATE TABLE IF NOT EXISTS presentation_native_documents (
        id VARCHAR(80) PRIMARY KEY, tenant_id BIGINT NOT NULL, owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(160) NOT NULL, current_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ NULL
    )`,
    `CREATE TABLE IF NOT EXISTS presentation_native_versions (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, document_id VARCHAR(80) NOT NULL REFERENCES presentation_native_documents(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, job_id VARCHAR(100) NOT NULL UNIQUE,
        package_ref TEXT NOT NULL, package_digest CHAR(64) NOT NULL, manifest_json JSONB NOT NULL,
        created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(document_id,version)
    )`
];
const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_presentation_native_owner ON presentation_native_documents(tenant_id,owner_user_id,updated_at DESC) WHERE deleted_at IS NULL',
    'CREATE INDEX IF NOT EXISTS idx_presentation_native_versions ON presentation_native_versions(document_id,version DESC)'
];

module.exports = [{ id: '202611080001_presentation_native_offline', description: '新增原生PPTX离线编辑版本与来源包保存。',
    async upPg(client) { for (const statement of [...tables, ...indexes]) await client.query(statement); },
    async checkPg(client) {
        const result = await client.query("SELECT to_regclass(format('%I.presentation_native_documents', current_schema())) IS NOT NULL AND to_regclass(format('%I.presentation_native_versions', current_schema())) IS NOT NULL AS present");
        return result.rows[0]?.present === true;
    }
}];
module.exports.tables = tables;
module.exports.indexes = indexes;
