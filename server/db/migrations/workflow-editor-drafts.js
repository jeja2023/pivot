/* 编辑草稿独立保存，未完成配置不进入可执行发布版本。 */
module.exports = [{
    id: '202610200001_workflow_editor_drafts',
    description: '保存工作流编辑修订和个人使用偏好。',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS workflow_editor_drafts (
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                draft_key VARCHAR(120) NOT NULL,
                workflow_id BIGINT REFERENCES agent_workflows(id) ON DELETE CASCADE,
                name VARCHAR(100) NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                spec_text TEXT NOT NULL DEFAULT '{"nodes":[]}',
                revision INTEGER NOT NULL DEFAULT 1,
                base_version INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (user_id, draft_key)
            );
            CREATE TABLE IF NOT EXISTS workflow_user_preferences (
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                workflow_id BIGINT NOT NULL REFERENCES agent_workflows(id) ON DELETE CASCADE,
                favorite BOOLEAN NOT NULL DEFAULT FALSE,
                last_used_at TIMESTAMPTZ,
                PRIMARY KEY (user_id, workflow_id)
            );
            CREATE INDEX IF NOT EXISTS workflow_draft_user_updated_idx ON workflow_editor_drafts (user_id, updated_at DESC);
            COMMENT ON TABLE workflow_editor_drafts IS '与发布版本隔离的工作流编辑草稿';
            COMMENT ON TABLE workflow_user_preferences IS '工作流收藏与最近使用记录';
        `);
    }
}];
