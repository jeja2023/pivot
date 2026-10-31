'use strict';

module.exports = [{
    id: '202610310001_token_metrics_snapshot',
    description: 'Share a recomputable token metrics snapshot across application nodes.',
    async upPg(client) {
        await client.query(`CREATE TABLE IF NOT EXISTS token_metrics_snapshot (
            id SMALLINT PRIMARY KEY CHECK (id = 1),
            day_start TIMESTAMPTZ NOT NULL,
            day_end TIMESTAMPTZ NOT NULL,
            all_rows JSONB NOT NULL,
            today_rows JSONB NOT NULL,
            computed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
        )`);
    },
    async checkPg(client) {
        const result = await client.query("SELECT to_regclass(format('%I.%I', current_schema(), 'token_metrics_snapshot')) IS NOT NULL AS present");
        return result.rows[0]?.present === true;
    }
}];
