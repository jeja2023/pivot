'use strict';

module.exports = [{
    id: '202610180008_model_usage_prompt_cache_telemetry',
    description: 'Persist provider-observed prompt cache read and creation tokens without changing billing token totals.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE model_usage_events
                ADD COLUMN IF NOT EXISTS cache_read_tokens BIGINT NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS cache_observed BOOLEAN NOT NULL DEFAULT FALSE;
            CREATE INDEX IF NOT EXISTS idx_model_usage_events_cache_observed
                ON model_usage_events(model_id, created_at DESC) WHERE cache_observed = TRUE;
        `);
    }
}];
