module.exports = [{
    id: '202609260014_agent_evidence_items',
    description: 'Persist tool-derived source references and excerpts for Agent task verification and review.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_evidence_items (
                evidence_id VARCHAR(128) PRIMARY KEY,
                run_id VARCHAR(128) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tool_name VARCHAR(160) NOT NULL DEFAULT '',
                source_type VARCHAR(60) NOT NULL DEFAULT 'tool',
                source_title VARCHAR(500) NOT NULL DEFAULT '',
                source_url TEXT NOT NULL DEFAULT '',
                excerpt TEXT NOT NULL DEFAULT '',
                content_digest CHAR(64) NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(run_id, content_digest)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_evidence_items_run
                ON agent_evidence_items(run_id, created_at ASC);
        `);
    }
}];
