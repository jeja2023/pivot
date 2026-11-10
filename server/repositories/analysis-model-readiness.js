'use strict';

const { queryOne } = require('../db/client');
const { biError } = require('../services/data-analysis/bi/errors');

async function schemaContract() {
    const row = await queryOne(`SELECT
        EXISTS(SELECT 1 FROM schema_migrations WHERE id='202611090001_analysis_node_flow') AS migrated,
        EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='analysis_ingestion_sessions' AND column_name='source_metadata_json' AND is_nullable='NO') AS source_metadata,
        EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='analysis_dataset_versions'::regclass AND tgname='analysis_dataset_version_immutable' AND tgenabled='O') AS version_protection,
        EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('idx_analysis_dataset_append_batch') AND indisvalid AND indisunique) AS batch_protection,
        EXISTS(SELECT 1 FROM pg_index
            WHERE indexrelid=to_regclass(format('%I.%I',current_schema(),'idx_analysis_job_result_cache'))
              AND indrelid=to_regclass(format('%I.%I',current_schema(),'analysis_query_jobs')) AND indisvalid) AS result_cache,
        (SELECT COUNT(*) FROM pg_trigger WHERE tgname='analysis_release_transaction_lock' AND tgrelid IN (to_regclass('analysis_data_models'),to_regclass('analysis_data_model_versions'),to_regclass('analysis_query_jobs')) AND tgenabled='O' AND tgtype=30) AS release_locks,
        (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('analysis_release_model_write','analysis_release_version_write','analysis_release_job_write','analysis_release_switch_lock','analysis_release_switch_revision') AND tgrelid IN (to_regclass('analysis_data_models'),to_regclass('analysis_data_model_versions'),to_regclass('analysis_query_jobs'),to_regclass('analysis_operation_state')) AND tgenabled='O') AS release_guards,
        (to_regclass('analysis_operation_buckets') IS NOT NULL AND to_regclass('analysis_operation_state') IS NOT NULL) AS operations,
        (SELECT COUNT(*) FROM pg_trigger WHERE tgname='analysis_security_event' AND tgrelid IN (to_regclass('users'),to_regclass('analysis_datasets'),to_regclass('analysis_data_models'),to_regclass('analysis_field_governance'),to_regclass('analysis_audit_events'),to_regclass('analysis_saved_views'),to_regclass('analysis_dashboards'),to_regclass('analysis_metric_definitions')) AND tgenabled='O') AS security_protections,
        EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='analysis_security_outbox_immutable' AND tgrelid=to_regclass('analysis_security_outbox') AND tgenabled='O') AS journal_protection,
        (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='analysis_query_jobs' AND column_name IN ('execution_epoch','lease_expires_at','binding_revision','source_run_id','result_format','runtime_protocol','result_page_object_id','ingestion_session_id','execution_metrics_json','cancel_cause')) AS fields,
        (SELECT COUNT(*) FROM pg_trigger WHERE tgrelid='analysis_source_manifest_members'::regclass AND tgname IN ('analysis_manifest_member_immutable','analysis_manifest_member_frozen') AND tgenabled='O') AS protections,
        EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='analysis_query_jobs'::regclass AND tgname='analysis_query_claim_contract' AND tgenabled='O') AS claim_protection,
        (SELECT COUNT(*) FROM pg_trigger WHERE tgrelid IN (to_regclass('analysis_ingestion_sessions'),to_regclass('analysis_ingestion_chunks')) AND tgname IN ('analysis_ingestion_contract_immutable','analysis_ingestion_chunk_immutable','analysis_ingestion_parts_frozen') AND tgenabled='O') AS ingestion_protections,
        EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('idx_analysis_model_active_refresh') AND indisvalid AND indisunique) AS refresh_unique`);
    if (!row?.migrated || !row.source_metadata || !row.version_protection || !row.batch_protection || !row.result_cache || !row.operations || Number(row.release_locks) !== 3 || Number(row.release_guards) !== 5 || Number(row.fields) !== 10 || Number(row.protections) !== 2 || !row.claim_protection || Number(row.security_protections) !== 8 || !row.journal_protection || Number(row.ingestion_protections) !== 3 || !row.refresh_unique) throw biError('ANALYSIS_MODEL_SCHEMA_INCOMPATIBLE', '数据库尚未完成本版本的数据建模迁移或保护约束，请停止旧执行器并完成迁移。', 503);
    return { schemaVersion: '202611090001', runtimeProtocol: 2 };
}

module.exports = { schemaContract };
