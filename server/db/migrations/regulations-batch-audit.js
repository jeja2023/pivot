'use strict';

module.exports = [{
    id: '202610120006_regulations_batch_audit',
    description: 'Add reversible per-document audit records for regulation batch updates.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS regulation_document_change_logs (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                batch_id TEXT NOT NULL,
                document_id BIGINT NOT NULL REFERENCES regulation_documents(id) ON DELETE CASCADE,
                actor_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                action TEXT NOT NULL DEFAULT 'batch_update',
                before_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                after_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                reverted_at TIMESTAMPTZ,
                reverted_by_user BIGINT REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_regulation_document_change_logs_batch
                ON regulation_document_change_logs(batch_id, reverted_at, document_id);
        `);
    }
}];
