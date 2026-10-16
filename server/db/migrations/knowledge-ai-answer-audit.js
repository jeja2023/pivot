'use strict';

// 知识库 AI 回答的可追溯审计。记录的是用户自己可访问的回答链路与证据摘要，
// 不改变知识库的用户隔离边界，也不把未授权的原文扩散到审计表。
module.exports = [{
    id: '202610160001_knowledge_ai_answer_audit',
    description: 'Add user-scoped knowledge AI answer audit and quality metrics records.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS knowledge_ai_answer_logs (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                session_id TEXT,
                surface TEXT NOT NULL DEFAULT 'chat',
                question TEXT NOT NULL DEFAULT '',
                rewritten_query TEXT NOT NULL DEFAULT '',
                answer TEXT NOT NULL DEFAULT '',
                model_name TEXT NOT NULL DEFAULT '',
                retrieval_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                grounding_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_knowledge_ai_answer_logs_user_created
                ON knowledge_ai_answer_logs(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_ai_answer_logs_surface_created
                ON knowledge_ai_answer_logs(surface, created_at DESC);
        `);
    }
}];
