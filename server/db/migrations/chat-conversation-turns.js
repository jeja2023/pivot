'use strict';

module.exports = [{
    id: '202610190002_chat_conversation_turns',
    description: '聊天请求幂等、任务身份、语义路由证据与结果度量。',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS chat_conversation_turns (
                id VARCHAR(80) PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                session_id VARCHAR(128) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                request_key VARCHAR(128) NOT NULL,
                input_hash CHAR(64) NOT NULL,
                user_message_id BIGINT NULL REFERENCES messages(id) ON DELETE SET NULL,
                assistant_message_id BIGINT NULL REFERENCES messages(id) ON DELETE SET NULL,
                run_id VARCHAR(128) NULL REFERENCES agent_runs(id) ON DELETE SET NULL,
                conversation_task_id VARCHAR(128) NULL,
                decision JSONB NOT NULL DEFAULT '{}'::jsonb,
                outcome JSONB NOT NULL DEFAULT '{}'::jsonb,
                status VARCHAR(24) NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','handed_off','completed','interrupted')),
                lease_token VARCHAR(80) NULL,
                lease_until TIMESTAMPTZ NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(user_id, session_id, request_key)
            );
            CREATE INDEX IF NOT EXISTS idx_chat_turns_user_session ON chat_conversation_turns(user_id, session_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_chat_turns_run ON chat_conversation_turns(run_id) WHERE run_id IS NOT NULL;
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_turn_id VARCHAR(80) REFERENCES chat_conversation_turns(id) ON DELETE SET NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_turn_assistant ON messages(conversation_turn_id) WHERE conversation_turn_id IS NOT NULL AND role = 'assistant';
        `);
    }
}];
