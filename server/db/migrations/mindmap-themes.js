'use strict';
module.exports = [{ id: '202610250005_mindmap_themes', description: '个人主题库按账号保存安全的主题配置。',
    async upPg(client) { await client.query(`CREATE TABLE IF NOT EXISTS mindmap_theme_library(id TEXT PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,content JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(user_id,name))`); await client.query('CREATE INDEX IF NOT EXISTS idx_mindmap_themes_user ON mindmap_theme_library(user_id,updated_at DESC)'); },
    async downPg(client) { await client.query('DROP TABLE IF EXISTS mindmap_theme_library'); }
}];
