'use strict';
module.exports = [{
    id: '202610250001_mindmap_workbench',
    description: '思维导图幂等保存与可恢复导出任务。',
    async upPg(client) {
        await client.query(`CREATE TABLE IF NOT EXISTS mindmap_requests (
            user_id BIGINT NOT NULL, request_key TEXT NOT NULL, input_hash TEXT NOT NULL,
            artifact_id BIGINT NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE,
            version_id BIGINT NOT NULL REFERENCES agent_artifact_versions(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id, request_key))`);
        await client.query(`CREATE TABLE IF NOT EXISTS mindmap_exports (
            id TEXT PRIMARY KEY, user_id BIGINT NOT NULL, artifact_id BIGINT NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE,
            version_id BIGINT NOT NULL REFERENCES agent_artifact_versions(id) ON DELETE CASCADE,
            format TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', rendition_id BIGINT,
            error_message TEXT NOT NULL DEFAULT '', lease_token TEXT, lease_until TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(user_id,artifact_id,version_id,format))`);
        await client.query("CREATE INDEX IF NOT EXISTS idx_mindmap_library ON agent_artifacts(user_id,updated_at DESC,id DESC) WHERE type='mindmap' AND status<>'deleted'");
        await client.query('CREATE INDEX IF NOT EXISTS idx_mindmap_export_queue ON mindmap_exports(status,lease_until,created_at)');
    },
    async downPg(client) {
        await client.query('DROP TABLE IF EXISTS mindmap_exports');
        await client.query('DROP TABLE IF EXISTS mindmap_requests');
        await client.query('DROP INDEX IF EXISTS idx_mindmap_library');
    }
}];
