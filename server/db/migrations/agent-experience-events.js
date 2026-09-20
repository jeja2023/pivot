'use strict';

// 个人 Agent 体验漏斗只记录低基数事件与受限元数据，绝不保存提示词正文、附件、
// 记忆内容或外部身份。它用于衡量首次设置和首任务路径，而不是行为追踪仓库。
module.exports = [{
    id: '202609200003_agent_experience_events',
    description: 'Persist privacy-bounded personal Agent onboarding and first-task experience events.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_experience_events (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tenant_id BIGINT,
                event_type VARCHAR(80) NOT NULL,
                session_id VARCHAR(128),
                run_id VARCHAR(128) REFERENCES agent_runs(id) ON DELETE SET NULL,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_agent_experience_events_user_time
                ON agent_experience_events(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_experience_events_type_time
                ON agent_experience_events(event_type, created_at DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_experience_first_task_created
                ON agent_experience_events(user_id, event_type)
                WHERE event_type = 'first_task_created';
            CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_experience_first_task_terminal
                ON agent_experience_events(user_id, event_type)
                WHERE event_type IN ('first_task_succeeded', 'first_task_failed');
        `);
    }
}];
