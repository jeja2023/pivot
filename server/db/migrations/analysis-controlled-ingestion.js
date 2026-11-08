'use strict';

const sourceContract = `(execution_kind='dataset_sql' AND dataset_id IS NOT NULL AND model_id IS NULL AND published_version IS NULL AND manifest_id IS NULL AND check_id IS NULL)
    OR (execution_kind='legacy_operation' AND dataset_id IS NULL AND model_id IS NULL AND published_version IS NULL AND manifest_id IS NULL AND check_id IS NULL AND sql_text='')
    OR (execution_kind='model_query' AND dataset_id IS NULL AND model_id IS NOT NULL AND published_version IS NOT NULL AND manifest_id IS NOT NULL AND check_id IS NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text='')
    OR (execution_kind='model_trial' AND dataset_id IS NULL AND model_id IS NOT NULL AND manifest_id IS NOT NULL AND check_id IS NOT NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text='')
    OR (execution_kind='model_export' AND dataset_id IS NULL AND model_id IS NOT NULL AND published_version IS NOT NULL AND manifest_id IS NOT NULL AND check_id IS NULL AND source_run_id IS NOT NULL AND result_format IN ('csv','xlsx') AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text='')
    OR (execution_kind IN ('model_check','model_refresh') AND dataset_id IS NULL AND model_id IS NOT NULL AND check_id IS NOT NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text='')
    OR (execution_kind='dataset_ingest' AND dataset_id IS NULL AND model_id IS NULL AND published_version IS NULL AND manifest_id IS NULL AND check_id IS NULL AND ingestion_session_id IS NOT NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text='')`;

module.exports = [{
    id: '202611070003_analysis_controlled_ingestion',
    description: 'Add bounded resumable source chunks and atomic large dataset version registration to the existing analysis queue.',
    async upPg(client) {
        await client.query(`CREATE TABLE IF NOT EXISTS analysis_ingestion_sessions (
            id TEXT PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            target_dataset_id TEXT NOT NULL UNIQUE,dataset_id TEXT REFERENCES analysis_datasets(id) ON DELETE SET NULL,
            name TEXT NOT NULL,original_name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('fact','dimension')),
            headers_json JSONB NOT NULL CHECK(jsonb_array_length(headers_json) BETWEEN 1 AND 120),
            expected_bytes BIGINT NOT NULL CHECK(expected_bytes BETWEEN 1 AND 2147483648),
            expected_chunks BIGINT NOT NULL CHECK(expected_chunks BETWEEN 1 AND 256),
            expected_rows BIGINT CHECK(expected_rows BETWEEN 1 AND 2000000),received_bytes BIGINT NOT NULL DEFAULT 0 CHECK(received_bytes>=0),
            status TEXT NOT NULL DEFAULT 'receiving' CHECK(status IN ('receiving','queued','running','succeeded','failed','cancelled')),
            request_key TEXT NOT NULL,request_hash TEXT NOT NULL,manifest_hash TEXT,
            job_id TEXT REFERENCES analysis_query_jobs(id) ON DELETE SET NULL,last_error TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '1 day',
            UNIQUE(user_id,request_key)
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS analysis_ingestion_chunks (
            session_id TEXT NOT NULL REFERENCES analysis_ingestion_sessions(id) ON DELETE CASCADE,
            part_index BIGINT NOT NULL CHECK(part_index BETWEEN 0 AND 255),
            object_id TEXT NOT NULL REFERENCES analysis_data_objects(id) ON DELETE RESTRICT,
            digest TEXT NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),byte_length BIGINT NOT NULL CHECK(byte_length BETWEEN 1 AND 8388608),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(session_id,part_index)
        )`);
        await client.query('ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS ingestion_session_id TEXT');
        await client.query(`DO $body$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='analysis_query_jobs'::regclass AND conname='analysis_query_job_ingestion_fkey') THEN
            ALTER TABLE analysis_query_jobs ADD CONSTRAINT analysis_query_job_ingestion_fkey FOREIGN KEY(ingestion_session_id) REFERENCES analysis_ingestion_sessions(id) ON DELETE RESTRICT; END IF; END $body$`);
        await client.query('ALTER TABLE analysis_query_jobs DROP CONSTRAINT IF EXISTS analysis_query_jobs_source_contract');
        await client.query(`ALTER TABLE analysis_query_jobs ADD CONSTRAINT analysis_query_jobs_source_contract CHECK (${sourceContract}) NOT VALID`);
        await client.query('ALTER TABLE analysis_query_jobs VALIDATE CONSTRAINT analysis_query_jobs_source_contract');
        await client.query('CREATE INDEX IF NOT EXISTS idx_analysis_ingestion_owner ON analysis_ingestion_sessions(user_id,status,created_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_analysis_ingestion_expiry ON analysis_ingestion_sessions(expires_at)');
        await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_ingestion_job ON analysis_query_jobs(ingestion_session_id) WHERE ingestion_session_id IS NOT NULL');
        await client.query(`CREATE OR REPLACE FUNCTION analysis_protect_ingestion_contract() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN IF (to_jsonb(NEW)-'received_bytes'-'status'-'job_id'-'manifest_hash'-'dataset_id'-'last_error'-'updated_at'-'expires_at')<>(to_jsonb(OLD)-'received_bytes'-'status'-'job_id'-'manifest_hash'-'dataset_id'-'last_error'-'updated_at'-'expires_at') THEN RAISE EXCEPTION '分批导入文件合同不可修改'; END IF;
            IF OLD.job_id IS NOT NULL AND (NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash) AND NEW.job_id IS NOT NULL THEN RAISE EXCEPTION '已提交的分批导入清单不可修改'; END IF; RETURN NEW; END $body$;
            DROP TRIGGER IF EXISTS analysis_ingestion_contract_immutable ON analysis_ingestion_sessions;
            CREATE TRIGGER analysis_ingestion_contract_immutable BEFORE UPDATE ON analysis_ingestion_sessions FOR EACH ROW EXECUTE FUNCTION analysis_protect_ingestion_contract();
            DROP TRIGGER IF EXISTS analysis_ingestion_chunk_immutable ON analysis_ingestion_chunks;
            CREATE TRIGGER analysis_ingestion_chunk_immutable BEFORE UPDATE ON analysis_ingestion_chunks FOR EACH ROW EXECUTE FUNCTION analysis_reject_snapshot_update();
            CREATE OR REPLACE FUNCTION analysis_protect_ingestion_parts() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN IF EXISTS(SELECT 1 FROM analysis_ingestion_sessions WHERE id=COALESCE(NEW.session_id,OLD.session_id) AND status<>'receiving') THEN RAISE EXCEPTION '已提交的分块清单不可追加或删除'; END IF; RETURN COALESCE(NEW,OLD); END $body$;
            DROP TRIGGER IF EXISTS analysis_ingestion_parts_frozen ON analysis_ingestion_chunks;
            CREATE TRIGGER analysis_ingestion_parts_frozen BEFORE INSERT OR DELETE ON analysis_ingestion_chunks FOR EACH ROW EXECUTE FUNCTION analysis_protect_ingestion_parts();`);
    }
}];
