module.exports = [{
    id: '202609260015_agent_artifact_annotations',
    description: 'Persist review annotations against immutable Agent artifact versions.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_artifact_annotations (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                artifact_id BIGINT NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE,
                artifact_version_id BIGINT REFERENCES agent_artifact_versions(id) ON DELETE SET NULL,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                target JSONB NOT NULL DEFAULT '{}'::jsonb,
                note TEXT NOT NULL,
                status VARCHAR(16) NOT NULL DEFAULT 'open',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                resolved_at TIMESTAMPTZ
            );
            CREATE INDEX IF NOT EXISTS idx_agent_artifact_annotations_artifact
                ON agent_artifact_annotations(artifact_id, status, created_at DESC);
        `);
    }
}];
