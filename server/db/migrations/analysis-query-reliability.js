'use strict';

module.exports = [{
    id: '202611050001_analysis_query_reliability',
    description: 'Track analysis query source versions and exact result limits for recoverable jobs.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS source_version BIGINT NOT NULL DEFAULT 0;
            ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS result_row_count BIGINT NOT NULL DEFAULT 0;
            ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS result_truncated BOOLEAN NOT NULL DEFAULT FALSE;
            CREATE INDEX IF NOT EXISTS idx_analysis_query_jobs_stale ON analysis_query_jobs(locked_at) WHERE status = 'running';
        `);
    }
}];
