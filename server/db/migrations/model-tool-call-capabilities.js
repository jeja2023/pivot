module.exports = [
    {
        id: '202609050004_model_tool_call_capabilities',
        description: 'Persist native tool-call capability probing and fallback state for model endpoints.',
        up(db) {
            const prepare = db.prepare.bind(db);
            const table = prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'models'").get();
            if (!table) return;
            const columns = new Set(prepare('PRAGMA table_info(models)').all().map(column => column.name));
            const definitions = {
                supports_tool_calls: 'INTEGER NOT NULL DEFAULT 0',
                tool_call_mode: "TEXT NOT NULL DEFAULT 'auto'",
                tool_call_probe_status: "TEXT NOT NULL DEFAULT 'unknown'",
                tool_call_probe_protocol: "TEXT NOT NULL DEFAULT ''",
                tool_call_probe_error: "TEXT NOT NULL DEFAULT ''",
                tool_call_probed_at: 'DATETIME'
            };
            for (const [name, definition] of Object.entries(definitions)) {
                if (!columns.has(name)) db.exec(`ALTER TABLE models ADD COLUMN ${name} ${definition}`);
            }
            db.exec('CREATE INDEX IF NOT EXISTS idx_models_tool_call_probe ON models(status, tool_call_probe_status, tool_call_probed_at DESC)');
        },
        async upPg(client) {
            await client.query(`
                ALTER TABLE models
                    ADD COLUMN IF NOT EXISTS supports_tool_calls BOOLEAN NOT NULL DEFAULT FALSE,
                    ADD COLUMN IF NOT EXISTS tool_call_mode VARCHAR(16) NOT NULL DEFAULT 'auto',
                    ADD COLUMN IF NOT EXISTS tool_call_probe_status VARCHAR(16) NOT NULL DEFAULT 'unknown',
                    ADD COLUMN IF NOT EXISTS tool_call_probe_protocol VARCHAR(32) NOT NULL DEFAULT '',
                    ADD COLUMN IF NOT EXISTS tool_call_probe_error TEXT NOT NULL DEFAULT '',
                    ADD COLUMN IF NOT EXISTS tool_call_probed_at TIMESTAMPTZ;
                CREATE INDEX IF NOT EXISTS idx_models_tool_call_probe
                    ON models(status, tool_call_probe_status, tool_call_probed_at DESC);
            `);
        }
    }
];
