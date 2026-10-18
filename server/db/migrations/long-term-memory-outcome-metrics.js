'use strict';

module.exports = [{
    id: '202610170014_long_term_memory_outcome_metrics',
    description: 'Persist monthly long-term Memory utility, conflict, expiry and revocation-residual evidence.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS memory_quality_periods (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                period_start DATE NOT NULL,
                period_end DATE NOT NULL,
                metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
                evaluated_count INTEGER NOT NULL DEFAULT 0,
                status VARCHAR(32) NOT NULL DEFAULT 'insufficient_data',
                computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(user_id, period_start, period_end),
                CHECK (period_end > period_start)
            );
            CREATE INDEX IF NOT EXISTS idx_memory_quality_periods_user
                ON memory_quality_periods(user_id, period_end DESC, computed_at DESC);
        `);
    }
}];
