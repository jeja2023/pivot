'use strict';
module.exports = [{
    id: '202610250003_mindmap_previews', description: '按导图版本缓存受控缩略图。',
    async upPg(client) { await client.query(`CREATE TABLE IF NOT EXISTS mindmap_thumbnails(artifact_id BIGINT PRIMARY KEY REFERENCES agent_artifacts(id) ON DELETE CASCADE,version_id BIGINT NOT NULL REFERENCES agent_artifact_versions(id) ON DELETE CASCADE,renderer_version TEXT NOT NULL,content BYTEA NOT NULL CHECK(octet_length(content)<=65536),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`); },
    async downPg(client) { await client.query('DROP TABLE IF EXISTS mindmap_thumbnails'); }
}];
