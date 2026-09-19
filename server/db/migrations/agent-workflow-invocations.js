'use strict';

const migration = {
    id: '202609190004_agent_workflow_invocations',
    description: 'Persist nested workflow invocation identity, fixed version and terminal state.',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS agent_workflow_invocations (
                invocation_id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                parent_invocation_id TEXT,
                caller_node_key TEXT NOT NULL DEFAULT '',
                workflow_id INTEGER NOT NULL,
                workflow_version_id INTEGER,
                workflow_version INTEGER,
                invocation_path TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'running',
                input_json TEXT NOT NULL DEFAULT '{}',
                output_json TEXT,
                error_message TEXT DEFAULT '',
                created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                completed_at DATETIME,
                UNIQUE(run_id, invocation_path),
                FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_agent_workflow_invocations_run ON agent_workflow_invocations(run_id, status, created_at);
        `);
    },
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_workflow_invocations (
                invocation_id VARCHAR(128) PRIMARY KEY,
                run_id VARCHAR(128) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                parent_invocation_id VARCHAR(128),
                caller_node_key VARCHAR(128) NOT NULL DEFAULT '',
                workflow_id BIGINT NOT NULL,
                workflow_version_id BIGINT,
                workflow_version INTEGER,
                invocation_path TEXT NOT NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'running',
                input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                output_json JSONB,
                error_message TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                completed_at TIMESTAMPTZ,
                UNIQUE(run_id, invocation_path)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_workflow_invocations_run ON agent_workflow_invocations(run_id, status, created_at);
        `);
    }
};

module.exports = [migration];
