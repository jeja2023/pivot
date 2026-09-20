module.exports = [
    {
        id: '202609050004_model_tool_call_capabilities',
        description: 'Persist native tool-call capability probing and fallback state for model endpoints.',
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
