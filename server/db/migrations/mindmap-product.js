'use strict';
module.exports = [{
    id: '202610250002_mindmap_product', description: '思维导图组织、模板和按用户授权协作。',
    async upPg(client) {
        await client.query(`CREATE TABLE IF NOT EXISTS mindmap_user_settings(artifact_id BIGINT NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE,user_id BIGINT NOT NULL,favorite BOOLEAN NOT NULL DEFAULT FALSE,tags JSONB NOT NULL DEFAULT '[]',updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(artifact_id,user_id))`);
        await client.query(`CREATE TABLE IF NOT EXISTS mindmap_templates(id TEXT PRIMARY KEY,user_id BIGINT NOT NULL,name TEXT NOT NULL,content TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query(`CREATE TABLE IF NOT EXISTS mindmap_workspaces(artifact_id BIGINT PRIMARY KEY REFERENCES agent_artifacts(id) ON DELETE CASCADE,enabled BOOLEAN NOT NULL DEFAULT FALSE,revision BIGINT NOT NULL DEFAULT 1,epoch TEXT NOT NULL DEFAULT '',y_state BYTEA,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query(`CREATE TABLE IF NOT EXISTS mindmap_members(artifact_id BIGINT NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE,user_id BIGINT NOT NULL,role TEXT NOT NULL CHECK(role IN ('viewer','editor')),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(artifact_id,user_id))`);
        await client.query('CREATE INDEX IF NOT EXISTS idx_mindmap_members_user ON mindmap_members(user_id,artifact_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_mindmap_templates_user ON mindmap_templates(user_id,updated_at DESC)');
    },
    async downPg(client) {
        await client.query('DROP TABLE IF EXISTS mindmap_members'); await client.query('DROP TABLE IF EXISTS mindmap_workspaces');
        await client.query('DROP TABLE IF EXISTS mindmap_templates'); await client.query('DROP TABLE IF EXISTS mindmap_user_settings');
    }
}];
