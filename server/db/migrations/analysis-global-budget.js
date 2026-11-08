'use strict';

module.exports = [{
    id: '202611070002_analysis_global_budget',
    description: 'Share persistent runtime slots with legacy analysis and bound all queued job deadlines.',
    async upPg(client) {
        await client.query(`ALTER TABLE analysis_query_jobs DROP CONSTRAINT IF EXISTS analysis_query_jobs_source_contract;
            ALTER TABLE analysis_query_jobs ADD CONSTRAINT analysis_query_jobs_source_contract CHECK (
            (execution_kind='dataset_sql' AND dataset_id IS NOT NULL AND model_id IS NULL AND published_version IS NULL AND manifest_id IS NULL AND check_id IS NULL)
            OR (execution_kind='legacy_operation' AND dataset_id IS NULL AND model_id IS NULL AND published_version IS NULL AND manifest_id IS NULL AND check_id IS NULL AND sql_text='')
            OR (execution_kind='model_query' AND dataset_id IS NULL AND model_id IS NOT NULL AND published_version IS NOT NULL AND manifest_id IS NOT NULL AND check_id IS NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text='')
            OR (execution_kind='model_trial' AND dataset_id IS NULL AND model_id IS NOT NULL AND manifest_id IS NOT NULL AND check_id IS NOT NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text='')
            OR (execution_kind='model_export' AND dataset_id IS NULL AND model_id IS NOT NULL AND published_version IS NOT NULL AND manifest_id IS NOT NULL AND check_id IS NULL AND source_run_id IS NOT NULL AND result_format IN ('csv','xlsx') AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text='')
            OR (execution_kind IN ('model_check','model_refresh') AND dataset_id IS NULL AND model_id IS NOT NULL AND check_id IS NOT NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text='')) NOT VALID;
            ALTER TABLE analysis_query_jobs VALIDATE CONSTRAINT analysis_query_jobs_source_contract;
            UPDATE analysis_query_jobs SET deadline_at=COALESCE(deadline_at,created_at+INTERVAL '180 seconds'),queue_deadline_at=COALESCE(queue_deadline_at,created_at+INTERVAL '120 seconds') WHERE deadline_at IS NULL OR queue_deadline_at IS NULL;`);
    }
}];
