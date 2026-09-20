'use strict';

const migration = {
    id: '202609200002_agent_workflow_trigger_events',
    description: 'Persist workflow trigger receipt, dispatch, failure and replay diagnostics without exposing trigger secrets.',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS agent_workflow_trigger_events (
                id TEXT PRIMARY KEY,
                trigger_id INTEGER NOT NULL,
                run_id TEXT,
                replay_of_event_id TEXT,
                event_type TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'received',
                dedupe_key TEXT DEFAULT '',
                watermark_before TEXT DEFAULT '',
                watermark_after TEXT DEFAULT '',
                input_json TEXT NOT NULL DEFAULT '{}',
                source_meta_json TEXT NOT NULL DEFAULT '{}',
                goal TEXT DEFAULT '',
                error_message TEXT DEFAULT '',
                created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                completed_at DATETIME,
                FOREIGN KEY (trigger_id) REFERENCES agent_workflow_triggers(id) ON DELETE CASCADE,
                FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE SET NULL,
                FOREIGN KEY (replay_of_event_id) REFERENCES agent_workflow_trigger_events(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS idx_agent_workflow_trigger_events_trigger
                ON agent_workflow_trigger_events(trigger_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_workflow_trigger_events_run
                ON agent_workflow_trigger_events(run_id, created_at DESC);
        `);
    },
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_workflow_trigger_events (
                id VARCHAR(64) PRIMARY KEY,
                trigger_id BIGINT NOT NULL REFERENCES agent_workflow_triggers(id) ON DELETE CASCADE,
                run_id VARCHAR(128) REFERENCES agent_runs(id) ON DELETE SET NULL,
                replay_of_event_id VARCHAR(64) REFERENCES agent_workflow_trigger_events(id) ON DELETE SET NULL,
                event_type VARCHAR(32) NOT NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'received',
                dedupe_key VARCHAR(256) NOT NULL DEFAULT '',
                watermark_before TEXT NOT NULL DEFAULT '',
                watermark_after TEXT NOT NULL DEFAULT '',
                input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                source_meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                goal TEXT NOT NULL DEFAULT '',
                error_message TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                completed_at TIMESTAMPTZ
            );
            CREATE INDEX IF NOT EXISTS idx_agent_workflow_trigger_events_trigger
                ON agent_workflow_trigger_events(trigger_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_workflow_trigger_events_run
                ON agent_workflow_trigger_events(run_id, created_at DESC);
        `);
    }
};

module.exports = [migration];
