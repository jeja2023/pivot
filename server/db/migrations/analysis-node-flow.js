'use strict';

module.exports = [{
    id: '202611090001_analysis_node_flow',
    description: '为节点预览与物化接入持久分析任务及运行监测。',
    async upPg(client) {
        await client.query('ALTER TABLE analysis_query_jobs DROP CONSTRAINT IF EXISTS analysis_query_jobs_source_contract');
        await client.query(`ALTER TABLE analysis_query_jobs ADD CONSTRAINT analysis_query_jobs_source_contract CHECK (
            (execution_kind='dataset_sql' AND dataset_id IS NOT NULL AND model_id IS NULL AND published_version IS NULL AND manifest_id IS NULL AND check_id IS NULL)
            OR (execution_kind='legacy_operation' AND dataset_id IS NULL AND model_id IS NULL AND published_version IS NULL AND manifest_id IS NULL AND check_id IS NULL AND sql_text='')
            OR (execution_kind='model_query' AND dataset_id IS NULL AND model_id IS NOT NULL AND published_version IS NOT NULL AND manifest_id IS NOT NULL AND check_id IS NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text='')
            OR (execution_kind='model_trial' AND dataset_id IS NULL AND model_id IS NOT NULL AND manifest_id IS NOT NULL AND check_id IS NOT NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text='')
            OR (execution_kind='model_export' AND dataset_id IS NULL AND model_id IS NOT NULL AND published_version IS NOT NULL AND manifest_id IS NOT NULL AND check_id IS NULL AND source_run_id IS NOT NULL AND result_format IN ('csv','xlsx') AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text='')
            OR (execution_kind IN ('model_check','model_refresh') AND dataset_id IS NULL AND model_id IS NOT NULL AND check_id IS NOT NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text='')
            OR (execution_kind='dataset_ingest' AND dataset_id IS NULL AND model_id IS NULL AND published_version IS NULL AND manifest_id IS NULL AND check_id IS NULL AND ingestion_session_id IS NOT NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text='')
            OR (execution_kind IN ('model_node_preview','model_node_dataset') AND dataset_id IS NULL AND model_id IS NOT NULL AND published_version IS NULL AND check_id IS NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text='' AND COALESCE(jsonb_typeof(query_ast_json->'flowDefinition')='object',FALSE))
        ) NOT VALID`);
        await client.query('ALTER TABLE analysis_query_jobs VALIDATE CONSTRAINT analysis_query_jobs_source_contract');
        await client.query('ALTER TABLE analysis_operation_buckets DROP CONSTRAINT IF EXISTS analysis_operation_buckets_operation_check');
        await client.query("ALTER TABLE analysis_operation_buckets ADD CONSTRAINT analysis_operation_buckets_operation_check CHECK(operation IN ('list','save','publish','submit','read','other','model_check','model_query','model_trial','model_refresh','model_export','dataset_ingest','model_node_preview','model_node_dataset'))");
        await client.query("CREATE INDEX IF NOT EXISTS idx_analysis_node_job_history ON analysis_query_jobs(user_id,model_id,created_at DESC,id DESC) WHERE execution_kind IN ('model_node_preview','model_node_dataset')");
        await client.query(`UPDATE analysis_datasets d SET truncated=2,truncation_reason='历史节点输出缺少完整来源血缘，覆盖范围未知，请重新生成。',source_version=source_version+1,updated_at=NOW()
            WHERE d.file_type='modeled' AND d.truncated<>2 AND NOT EXISTS(SELECT 1 FROM analysis_dataset_versions v WHERE v.dataset_id=d.id AND jsonb_typeof(v.manifest_json->'lineage'->'sources')='array')`);
    }
}];
