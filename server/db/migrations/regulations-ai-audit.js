'use strict';

// 法规问答记录答案生成时的版本化依据，避免日后法规更新后无法复核当时回答。
module.exports = [{
    id: '202610120005_regulations_ai_audit',
    description: 'Add traceable regulation AI answer audit logs.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS regulation_ai_answer_logs (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                document_id BIGINT REFERENCES regulation_documents(id) ON DELETE SET NULL,
                question TEXT NOT NULL DEFAULT '',
                answer TEXT NOT NULL DEFAULT '',
                model_name TEXT NOT NULL DEFAULT '',
                context_snapshot TEXT NOT NULL DEFAULT '',
                sources_json JSONB NOT NULL DEFAULT '[]'::jsonb,
                usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_regulation_ai_answer_logs_user_document
                ON regulation_ai_answer_logs(user_id, document_id, created_at DESC);
        `);
    }
}];
