'use strict';

module.exports = [{
    id: '202611070008_analysis_operations',
    description: 'Persist bounded execution resource measurements and operational SLI samples for BI models.',
    async upPg(client) {
        await client.query("ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS execution_metrics_json JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(execution_metrics_json)='object')");
        await client.query("ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS cancel_cause TEXT NOT NULL DEFAULT '' CHECK(cancel_cause IN ('','user','system'))");
        await client.query("UPDATE analysis_query_jobs SET cancel_cause='user' WHERE cancel_requested_at IS NOT NULL AND cancel_cause=''");
        await client.query(`CREATE TABLE IF NOT EXISTS analysis_operation_buckets (
            minute_at TIMESTAMPTZ NOT NULL,domain TEXT NOT NULL CHECK(domain IN ('control','task')),
            operation TEXT NOT NULL CHECK(operation IN ('list','save','publish','submit','read','other','model_check','model_query','model_trial','model_refresh','model_export','dataset_ingest')),
            outcome TEXT NOT NULL CHECK(outcome IN ('success','platform_failure','auth_denied','invalid','cancelled','quota_exceeded')),
            count BIGINT NOT NULL CHECK(count>0),quality_failures BIGINT NOT NULL DEFAULT 0,duration_sum_ms BIGINT NOT NULL DEFAULT 0,
            latency_counts BIGINT[] NOT NULL CHECK(array_length(latency_counts,1)=14),PRIMARY KEY(minute_at,domain,operation,outcome)
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS analysis_operation_state (
            id TEXT PRIMARY KEY CHECK(id='main'),monitoring_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_tick_at TIMESTAMPTZ,last_worker_poll_at TIMESTAMPTZ,last_error TEXT NOT NULL DEFAULT '',
            probe_config_json JSONB NOT NULL DEFAULT '{}',probe_revision BIGINT NOT NULL DEFAULT 1,
            pending_run_id TEXT REFERENCES analysis_query_jobs(id) ON DELETE SET NULL,probe_started_at TIMESTAMPTZ,probe_finished_at TIMESTAMPTZ,
            probe_outcome TEXT NOT NULL DEFAULT 'unconfigured',probe_error TEXT NOT NULL DEFAULT '',access_fenced BOOLEAN NOT NULL DEFAULT FALSE,
            fence_reason TEXT NOT NULL DEFAULT '',alert_state_json JSONB NOT NULL DEFAULT '{}',updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await client.query("INSERT INTO analysis_operation_state(id) VALUES ('main') ON CONFLICT(id) DO NOTHING");
        await client.query("CREATE INDEX IF NOT EXISTS idx_analysis_job_completion ON analysis_query_jobs(completed_at) WHERE execution_kind IN ('model_check','model_query','model_trial','model_refresh','model_export','dataset_ingest')");
    }
}];
