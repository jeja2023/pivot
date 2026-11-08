'use strict';

module.exports = [{
    id: '202611070006_analysis_model_migration',
    description: 'Preserve exploration provenance and idempotent formal draft conversion.',
    async upPg(client) {
        await client.query("ALTER TABLE analysis_data_model_checks ADD COLUMN IF NOT EXISTS comparison_json JSONB NOT NULL DEFAULT '{}'::jsonb");
        await client.query(`CREATE TABLE IF NOT EXISTS analysis_model_origins (
            model_id TEXT PRIMARY KEY REFERENCES analysis_data_models(id) ON DELETE RESTRICT,
            source_model_id TEXT NOT NULL REFERENCES analysis_data_models(id) ON DELETE RESTRICT,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
            request_key TEXT NOT NULL,request_hash TEXT NOT NULL,snapshot_hash TEXT NOT NULL,
            snapshot_json JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(user_id,source_model_id,request_key),CHECK(model_id<>source_model_id)
        )`);
        await client.query(`CREATE OR REPLACE FUNCTION analysis_protect_model_origin() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN RAISE EXCEPTION '旧模型迁移来源不可改写'; END $body$;
            DROP TRIGGER IF EXISTS analysis_model_origin_immutable ON analysis_model_origins;
            CREATE TRIGGER analysis_model_origin_immutable BEFORE UPDATE ON analysis_model_origins FOR EACH ROW EXECUTE FUNCTION analysis_protect_model_origin()`);
        await client.query(`CREATE OR REPLACE FUNCTION analysis_protect_query_contract() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN
                IF OLD.runtime_protocol>=2 AND (
                    (to_jsonb(NEW)->'query_ast_json') IS DISTINCT FROM (to_jsonb(OLD)->'query_ast_json') OR
                    ROW(NEW.id,NEW.user_id,NEW.dataset_id,NEW.model_id,NEW.execution_kind,NEW.published_version,NEW.check_id,NEW.source_run_id,NEW.result_format,NEW.request_key,NEW.request_hash,NEW.runtime_protocol,NEW.binding_revision)
                    IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.dataset_id,OLD.model_id,OLD.execution_kind,OLD.published_version,OLD.check_id,OLD.source_run_id,OLD.result_format,OLD.request_key,OLD.request_hash,OLD.runtime_protocol,OLD.binding_revision) OR
                    OLD.manifest_id IS NOT NULL AND NEW.manifest_id IS DISTINCT FROM OLD.manifest_id)
                THEN RAISE EXCEPTION '正式分析任务请求及固定来源不可改写'; END IF; RETURN NEW;
            END $body$;
            DROP TRIGGER IF EXISTS analysis_query_contract_immutable ON analysis_query_jobs;
            CREATE TRIGGER analysis_query_contract_immutable BEFORE UPDATE ON analysis_query_jobs FOR EACH ROW EXECUTE FUNCTION analysis_protect_query_contract()`);
    }
}];
