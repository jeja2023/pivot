'use strict';

// 正式模型增量合同。旧模型默认仍为探索类型；数据对象仅登记控制面，字节存储复用 CAS。
const tables = [
    `CREATE TABLE IF NOT EXISTS analysis_data_model_nodes (
        id TEXT NOT NULL, model_id TEXT NOT NULL REFERENCES analysis_data_models(id) ON DELETE CASCADE,
        dataset_id TEXT NOT NULL REFERENCES analysis_datasets(id) ON DELETE RESTRICT,
        role TEXT NOT NULL CHECK (role IN ('fact', 'dimension')),
        name TEXT NOT NULL, grain_keys_json JSONB NOT NULL DEFAULT '[]',
        config_json JSONB NOT NULL DEFAULT '{}', PRIMARY KEY (model_id, id), UNIQUE (model_id, dataset_id)
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_model_dimensions (
        id TEXT NOT NULL, model_id TEXT NOT NULL REFERENCES analysis_data_models(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL, field_key TEXT NOT NULL, name TEXT NOT NULL,
        config_json JSONB NOT NULL, PRIMARY KEY (model_id, id),
        FOREIGN KEY (model_id, node_id) REFERENCES analysis_data_model_nodes(model_id, id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_data_objects (
        id TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        digest TEXT NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'), byte_length BIGINT NOT NULL CHECK (byte_length >= 0),
        storage_key TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('staging','ready','quarantined','deleting','expired')),
        purpose TEXT NOT NULL CHECK (purpose IN ('source','result','export','backup')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ready_at TIMESTAMPTZ, verified_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ, deletion_epoch BIGINT NOT NULL DEFAULT 0,
        UNIQUE (user_id, digest, purpose)
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_source_manifests (
        id TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
        manifest_json JSONB NOT NULL, coverage TEXT NOT NULL CHECK (coverage IN ('full','incremental','partial','unknown')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (user_id, manifest_hash)
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_source_manifest_members (
        manifest_id TEXT NOT NULL REFERENCES analysis_source_manifests(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL, dataset_id TEXT NOT NULL REFERENCES analysis_datasets(id) ON DELETE RESTRICT,
        dataset_version_id TEXT NOT NULL REFERENCES analysis_dataset_versions(id) ON DELETE RESTRICT,
        object_id TEXT NOT NULL REFERENCES analysis_data_objects(id) ON DELETE RESTRICT,
        schema_hash TEXT NOT NULL, governance_hash TEXT NOT NULL, source_revision BIGINT NOT NULL,
        input_batch_id TEXT NOT NULL DEFAULT '', watermark_json JSONB NOT NULL DEFAULT '{}',
        coverage TEXT NOT NULL CHECK (coverage IN ('full','incremental','partial','unknown')),
        PRIMARY KEY (manifest_id, node_id)
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_object_references (
        object_id TEXT NOT NULL REFERENCES analysis_data_objects(id) ON DELETE RESTRICT,
        reference_kind TEXT NOT NULL CHECK (reference_kind IN ('manifest','run','export','backup','lease')),
        reference_id TEXT NOT NULL, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (object_id, reference_kind, reference_id)
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_data_model_versions (
        model_id TEXT NOT NULL REFERENCES analysis_data_models(id) ON DELETE RESTRICT,
        version BIGINT NOT NULL CHECK (version > 0), definition_json JSONB NOT NULL,
        semantic_hash TEXT NOT NULL CHECK (semantic_hash ~ '^[0-9a-f]{64}$'),
        policy_json JSONB NOT NULL, published_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
        review_json JSONB NOT NULL DEFAULT '{}', warning_acceptance_json JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (model_id, version), UNIQUE (model_id, request_key)
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_data_model_checks (
        id TEXT PRIMARY KEY, model_id TEXT NOT NULL REFERENCES analysis_data_models(id) ON DELETE RESTRICT,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        draft_revision BIGINT NOT NULL, published_version BIGINT,
        definition_json JSONB NOT NULL, semantic_hash TEXT NOT NULL, rules_hash TEXT NOT NULL,
        manifest_id TEXT REFERENCES analysis_source_manifests(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','passed','failed','cancelled','incomplete')),
        complete BOOLEAN NOT NULL DEFAULT FALSE, report_json JSONB NOT NULL DEFAULT '{}',
        request_key TEXT NOT NULL, request_hash TEXT NOT NULL, completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (model_id, user_id, request_key),
        CHECK (status <> 'passed' OR (complete AND completed_at IS NOT NULL AND manifest_id IS NOT NULL))
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_model_data_bindings (
        model_id TEXT NOT NULL, published_version BIGINT NOT NULL,
        manifest_id TEXT NOT NULL REFERENCES analysis_source_manifests(id) ON DELETE RESTRICT,
        check_id TEXT NOT NULL REFERENCES analysis_data_model_checks(id) ON DELETE RESTRICT,
        revision BIGINT NOT NULL DEFAULT 1, data_state TEXT NOT NULL DEFAULT 'available'
            CHECK (data_state IN ('available','pending','refresh_failed','source_unavailable')),
        last_refresh_error TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (model_id, published_version),
        FOREIGN KEY (model_id, published_version) REFERENCES analysis_data_model_versions(model_id, version) ON DELETE RESTRICT
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_model_reviews (
        id TEXT PRIMARY KEY,model_id TEXT NOT NULL REFERENCES analysis_data_models(id) ON DELETE RESTRICT,
        check_id TEXT NOT NULL REFERENCES analysis_data_model_checks(id) ON DELETE RESTRICT,
        owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        reviewer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT CHECK(reviewer_id<>owner_id),
        semantic_hash TEXT NOT NULL,rules_hash TEXT NOT NULL,warning_rules_hash TEXT NOT NULL,scope_hash TEXT NOT NULL,
        proposal_json JSONB NOT NULL,business_owner TEXT NOT NULL,maintenance_contact TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','rejected')),
        comment TEXT NOT NULL DEFAULT '',reviewed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        request_key TEXT NOT NULL,request_hash TEXT NOT NULL,UNIQUE(model_id,owner_id,request_key),
        CHECK((status='requested' AND reviewed_at IS NULL) OR (status<>'requested' AND reviewed_at IS NOT NULL))
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_authorization_revisions (
        resource_kind TEXT NOT NULL CHECK (resource_kind IN ('dataset','model','principal','organization','policy')),
        resource_id TEXT NOT NULL, revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (resource_kind, resource_id)
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_audit_events (
        id TEXT PRIMARY KEY, user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
        model_id TEXT, published_version BIGINT, run_id TEXT, action TEXT NOT NULL,
        outcome TEXT NOT NULL, error_code TEXT NOT NULL DEFAULT '', details_json JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), delivered_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_runtime_slots (
        id BIGINT PRIMARY KEY CHECK (id > 0), job_id TEXT UNIQUE REFERENCES analysis_query_jobs(id) ON DELETE RESTRICT,
        execution_epoch BIGINT NOT NULL DEFAULT 0, lease_expires_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_recovery_points (
        id TEXT PRIMARY KEY, database_position TEXT NOT NULL, object_manifest_json JSONB NOT NULL,
        manifest_digest TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('building','verified','failed','expired')),
        authorization_watermark TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), verified_at TIMESTAMPTZ
    )`
];

const alterations = [
    `ALTER TABLE analysis_data_models ADD COLUMN IF NOT EXISTS model_kind TEXT NOT NULL DEFAULT 'exploration' CHECK (model_kind IN ('exploration','production'))`,
    `ALTER TABLE analysis_data_models ADD COLUMN IF NOT EXISTS definition_json JSONB NOT NULL DEFAULT '{}'`,
    `ALTER TABLE analysis_data_models ADD COLUMN IF NOT EXISTS semantic_hash TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE analysis_data_models ADD COLUMN IF NOT EXISTS published_version BIGINT`,
    `ALTER TABLE analysis_data_models ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,
    `ALTER TABLE analysis_data_models ADD COLUMN IF NOT EXISTS authorization_revision BIGINT NOT NULL DEFAULT 1`,
    `ALTER TABLE analysis_data_models ADD COLUMN IF NOT EXISTS business_owner TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE analysis_data_models ADD COLUMN IF NOT EXISTS maintenance_contact TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE analysis_data_models ADD COLUMN IF NOT EXISTS sharing_review_id TEXT REFERENCES analysis_model_reviews(id) ON DELETE RESTRICT`,
    `ALTER TABLE analysis_data_model_relations ADD COLUMN IF NOT EXISTS left_node_id TEXT`,
    `ALTER TABLE analysis_data_model_relations ADD COLUMN IF NOT EXISTS right_node_id TEXT`,
    `ALTER TABLE analysis_data_model_relations ADD COLUMN IF NOT EXISTS key_pairs_json JSONB NOT NULL DEFAULT '[]'`,
    `ALTER TABLE analysis_data_model_relations ADD COLUMN IF NOT EXISTS relation_revision BIGINT NOT NULL DEFAULT 1`,
    `ALTER TABLE analysis_metric_definitions ADD COLUMN IF NOT EXISTS model_id TEXT REFERENCES analysis_data_models(id) ON DELETE CASCADE`,
    `ALTER TABLE analysis_metric_definitions ADD COLUMN IF NOT EXISTS model_member_id TEXT`,
    `ALTER TABLE analysis_metric_definitions ADD COLUMN IF NOT EXISTS metric_type TEXT`,
    `ALTER TABLE analysis_query_jobs ALTER COLUMN dataset_id DROP NOT NULL`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS execution_kind TEXT NOT NULL DEFAULT 'dataset_sql'`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS model_id TEXT REFERENCES analysis_data_models(id) ON DELETE RESTRICT`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS published_version BIGINT`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS manifest_id TEXT REFERENCES analysis_source_manifests(id) ON DELETE RESTRICT`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS check_id TEXT REFERENCES analysis_data_model_checks(id) ON DELETE RESTRICT`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS query_ast_json JSONB NOT NULL DEFAULT '{}'`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS authorization_vector_json JSONB NOT NULL DEFAULT '{}'`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS result_metadata_json JSONB NOT NULL DEFAULT '{}'`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS result_object_id TEXT REFERENCES analysis_data_objects(id) ON DELETE RESTRICT`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS result_page_object_id TEXT REFERENCES analysis_data_objects(id) ON DELETE RESTRICT`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS request_key TEXT`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS request_hash TEXT`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS execution_epoch BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS lease_owner TEXT`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS queue_deadline_at TIMESTAMPTZ`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS execution_deadline_at TIMESTAMPTZ`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS container_id TEXT`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS slot_id BIGINT`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS binding_revision BIGINT`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS source_run_id TEXT REFERENCES analysis_query_jobs(id) ON DELETE RESTRICT`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS result_format TEXT NOT NULL DEFAULT 'ndjson' CHECK(result_format IN ('ndjson','csv','xlsx'))`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ`,
    `ALTER TABLE analysis_query_jobs ADD COLUMN IF NOT EXISTS runtime_protocol BIGINT NOT NULL DEFAULT 1`
];

for (const table of ['analysis_saved_views', 'analysis_dashboard_items']) alterations.push(
    `ALTER TABLE ${table} ALTER COLUMN dataset_id DROP NOT NULL`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'dataset'`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS model_id TEXT REFERENCES analysis_data_models(id) ON DELETE RESTRICT`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS published_version BIGINT`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS binding_strategy TEXT NOT NULL DEFAULT 'latest_checked'`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS historical_manifest_id TEXT REFERENCES analysis_source_manifests(id) ON DELETE RESTRICT`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS last_run_id TEXT REFERENCES analysis_query_jobs(id) ON DELETE RESTRICT`
);
alterations.push(`ALTER TABLE analysis_dashboard_items ADD COLUMN IF NOT EXISTS last_successful_run_id TEXT REFERENCES analysis_query_jobs(id) ON DELETE RESTRICT`);

const constraints = [
    ['analysis_query_jobs', 'analysis_query_jobs_source_contract', `(execution_kind = 'dataset_sql' AND dataset_id IS NOT NULL AND model_id IS NULL AND published_version IS NULL AND manifest_id IS NULL AND check_id IS NULL)
        OR (execution_kind = 'model_query' AND dataset_id IS NULL AND model_id IS NOT NULL AND published_version IS NOT NULL AND manifest_id IS NOT NULL AND check_id IS NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text = '')
        OR (execution_kind = 'model_trial' AND dataset_id IS NULL AND model_id IS NOT NULL AND manifest_id IS NOT NULL AND check_id IS NOT NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text = '')
        OR (execution_kind = 'model_export' AND dataset_id IS NULL AND model_id IS NOT NULL AND published_version IS NOT NULL AND manifest_id IS NOT NULL AND check_id IS NULL AND source_run_id IS NOT NULL AND result_format IN ('csv','xlsx') AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text = '')
        OR (execution_kind='legacy_operation' AND dataset_id IS NULL AND model_id IS NULL AND published_version IS NULL AND manifest_id IS NULL AND check_id IS NULL AND sql_text='')
        OR (execution_kind IN ('model_check','model_refresh') AND dataset_id IS NULL AND model_id IS NOT NULL AND check_id IS NOT NULL AND request_key IS NOT NULL AND request_hash IS NOT NULL AND sql_text = '')`],
    ['analysis_data_model_relations', 'analysis_model_relation_nodes_contract', `(left_node_id IS NULL AND right_node_id IS NULL) OR (left_node_id IS NOT NULL AND right_node_id IS NOT NULL AND jsonb_array_length(key_pairs_json) BETWEEN 1 AND 3)`]
];
for (const table of ['analysis_saved_views', 'analysis_dashboard_items']) constraints.push([table, `${table}_source_contract`,
    `(source_type='dataset' AND dataset_id IS NOT NULL AND model_id IS NULL AND published_version IS NULL AND historical_manifest_id IS NULL)
    OR (source_type='model' AND dataset_id IS NULL AND model_id IS NOT NULL AND published_version IS NOT NULL AND binding_strategy IN ('latest_checked','historical') AND ((binding_strategy='historical' AND historical_manifest_id IS NOT NULL) OR (binding_strategy='latest_checked' AND historical_manifest_id IS NULL)))`]);

const indexes = [
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_model_single_fact ON analysis_data_model_nodes(model_id) WHERE role = 'fact'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_model_metric_member ON analysis_metric_definitions(model_id, model_member_id) WHERE model_id IS NOT NULL AND deleted_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_analysis_model_node_source ON analysis_data_model_nodes(dataset_id, model_id)`,
    `CREATE INDEX IF NOT EXISTS idx_analysis_manifest_dataset ON analysis_source_manifest_members(dataset_id, dataset_version_id)`,
    `CREATE INDEX IF NOT EXISTS idx_analysis_objects_gc ON analysis_data_objects(state, expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_analysis_object_reference_expiry ON analysis_object_references(expires_at) WHERE expires_at IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_analysis_model_check_definition ON analysis_data_model_checks(model_id, semantic_hash, manifest_id, created_at DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_job_model_idempotency ON analysis_query_jobs(user_id, model_id, execution_kind, request_key) WHERE request_key IS NOT NULL AND model_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_analysis_job_model_due ON analysis_query_jobs(execution_kind, status, next_run_at, user_id, created_at) WHERE execution_kind <> 'dataset_sql'`,
    `CREATE INDEX IF NOT EXISTS idx_analysis_job_model_lease ON analysis_query_jobs(lease_expires_at) WHERE execution_kind <> 'dataset_sql' AND status IN ('running','cancelling')`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_model_active_refresh ON analysis_query_jobs(model_id,published_version) WHERE execution_kind='model_refresh' AND status IN ('queued','running','retry_wait','cancelling')`,
    `CREATE INDEX IF NOT EXISTS idx_analysis_audit_pending ON analysis_audit_events(created_at, id) WHERE delivered_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_analysis_audit_model ON analysis_audit_events(model_id, created_at DESC)`
];
indexes.push(`CREATE INDEX IF NOT EXISTS idx_analysis_model_review_inbox ON analysis_model_reviews(reviewer_id,status,created_at DESC)`);
for (const table of ['analysis_saved_views', 'analysis_dashboard_items']) indexes.push(`CREATE INDEX IF NOT EXISTS idx_${table}_model ON ${table}(model_id,published_version) WHERE model_id IS NOT NULL`);

module.exports = [{
    id: '202611070001_analysis_model_contracts',
    description: 'Add production model contracts, immutable snapshots, source manifests and durable execution fields without promoting legacy exploration models.',
    async upPg(client) {
        for (const sql of tables) await client.query(sql);
        for (const sql of alterations) await client.query(sql);
        for (const [table, name, expression] of constraints) {
            const exists = await client.query('SELECT 1 FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2', [table, name]);
            if (!exists.rowCount) await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expression}) NOT VALID`);
            await client.query(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`);
        }
        for (const sql of indexes) await client.query(sql);
        await client.query(`CREATE OR REPLACE FUNCTION analysis_bump_authorization_revision() RETURNS trigger LANGUAGE plpgsql AS $body$
            DECLARE resource_kind_value TEXT; resource_id_value TEXT;
            BEGIN
                resource_kind_value := CASE TG_TABLE_NAME WHEN 'users' THEN 'principal' WHEN 'analysis_data_models' THEN 'model' ELSE 'dataset' END;
                IF TG_TABLE_NAME = 'analysis_field_governance' THEN resource_id_value := COALESCE(NEW.dataset_id, OLD.dataset_id);
                ELSE resource_id_value := COALESCE(NEW.id, OLD.id)::text; END IF;
                PERFORM pg_advisory_xact_lock(hashtext('pivot:analysis:authorization'), hashtext(resource_kind_value || ':' || resource_id_value));
                INSERT INTO analysis_authorization_revisions(resource_kind, resource_id, revision) VALUES (resource_kind_value, resource_id_value, 1)
                ON CONFLICT (resource_kind, resource_id) DO UPDATE SET revision=analysis_authorization_revisions.revision+1, updated_at=NOW();
                RETURN COALESCE(NEW, OLD);
            END $body$;
            DROP TRIGGER IF EXISTS analysis_principal_authorization_revision ON users;
            CREATE TRIGGER analysis_principal_authorization_revision BEFORE INSERT OR UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION analysis_bump_authorization_revision();
            DROP TRIGGER IF EXISTS analysis_dataset_authorization_revision ON analysis_datasets;
            CREATE TRIGGER analysis_dataset_authorization_revision BEFORE INSERT OR UPDATE OR DELETE ON analysis_datasets FOR EACH ROW EXECUTE FUNCTION analysis_bump_authorization_revision();
            DROP TRIGGER IF EXISTS analysis_model_authorization_revision ON analysis_data_models;
            CREATE TRIGGER analysis_model_authorization_revision BEFORE INSERT OR UPDATE OR DELETE ON analysis_data_models FOR EACH ROW EXECUTE FUNCTION analysis_bump_authorization_revision();
            DROP TRIGGER IF EXISTS analysis_field_authorization_revision ON analysis_field_governance;
            CREATE TRIGGER analysis_field_authorization_revision BEFORE INSERT OR UPDATE OR DELETE ON analysis_field_governance FOR EACH ROW EXECUTE FUNCTION analysis_bump_authorization_revision();`);
        await client.query(`CREATE OR REPLACE FUNCTION analysis_reject_snapshot_update() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN RAISE EXCEPTION '分析快照内容不可修改'; END $body$;
            CREATE OR REPLACE FUNCTION analysis_protect_completed_check() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN IF OLD.completed_at IS NOT NULL THEN RAISE EXCEPTION '已完成的分析检查不可修改'; END IF; RETURN NEW; END $body$;
            CREATE OR REPLACE FUNCTION analysis_protect_review() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN IF OLD.status<>'requested' OR (to_jsonb(NEW)-'status'-'comment'-'reviewed_at')<>(to_jsonb(OLD)-'status'-'comment'-'reviewed_at') THEN RAISE EXCEPTION '业务复核证据不可修改'; END IF; RETURN NEW; END $body$;
            CREATE OR REPLACE FUNCTION analysis_protect_manifest_members() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN
                IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM analysis_source_manifests WHERE id=NEW.manifest_id AND xmin::text=(pg_current_xact_id()::text::bigint % 4294967296)::text) THEN RAISE EXCEPTION '已提交的来源清单不可追加成员'; END IF;
                IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM analysis_source_manifests WHERE id=OLD.manifest_id) THEN RAISE EXCEPTION '来源清单成员不可单独删除'; END IF;
                RETURN COALESCE(NEW,OLD);
            END $body$;
            DROP TRIGGER IF EXISTS analysis_model_version_immutable ON analysis_data_model_versions;
            CREATE TRIGGER analysis_model_version_immutable BEFORE UPDATE ON analysis_data_model_versions FOR EACH ROW EXECUTE FUNCTION analysis_reject_snapshot_update();
            DROP TRIGGER IF EXISTS analysis_manifest_immutable ON analysis_source_manifests;
            CREATE TRIGGER analysis_manifest_immutable BEFORE UPDATE ON analysis_source_manifests FOR EACH ROW EXECUTE FUNCTION analysis_reject_snapshot_update();
            DROP TRIGGER IF EXISTS analysis_manifest_member_immutable ON analysis_source_manifest_members;
            CREATE TRIGGER analysis_manifest_member_immutable BEFORE UPDATE ON analysis_source_manifest_members FOR EACH ROW EXECUTE FUNCTION analysis_reject_snapshot_update();
            DROP TRIGGER IF EXISTS analysis_manifest_member_frozen ON analysis_source_manifest_members;
            CREATE TRIGGER analysis_manifest_member_frozen BEFORE INSERT OR DELETE ON analysis_source_manifest_members FOR EACH ROW EXECUTE FUNCTION analysis_protect_manifest_members();
            DROP TRIGGER IF EXISTS analysis_model_check_immutable ON analysis_data_model_checks;
            CREATE TRIGGER analysis_model_check_immutable BEFORE UPDATE ON analysis_data_model_checks FOR EACH ROW EXECUTE FUNCTION analysis_protect_completed_check();`);
        await client.query(`DROP TRIGGER IF EXISTS analysis_model_review_immutable ON analysis_model_reviews;
            CREATE TRIGGER analysis_model_review_immutable BEFORE UPDATE ON analysis_model_reviews FOR EACH ROW EXECUTE FUNCTION analysis_protect_review();`);
    }
}];
