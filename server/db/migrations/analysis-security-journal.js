'use strict';

const tables = [
    `CREATE TABLE IF NOT EXISTS analysis_security_state (
        id TEXT PRIMARY KEY CHECK(id='main'),origin_id UUID NOT NULL DEFAULT gen_random_uuid(),
        mode TEXT NOT NULL DEFAULT 'initializing' CHECK(mode IN ('initializing','ready','recovery_required')),
        enforced BOOLEAN NOT NULL DEFAULT FALSE,
        journal_position BIGINT NOT NULL DEFAULT 0,journal_hash TEXT NOT NULL DEFAULT '',
        recovery_reason TEXT NOT NULL DEFAULT '',recovery_started_at TIMESTAMPTZ,reconciled_at TIMESTAMPTZ,
        reconciled_hash TEXT NOT NULL DEFAULT '',pending_reconciliation_hash TEXT NOT NULL DEFAULT '',updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_security_revisions (
        resource_kind TEXT NOT NULL,resource_id TEXT NOT NULL,revision BIGINT NOT NULL DEFAULT 1,
        PRIMARY KEY(resource_kind,resource_id)
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_security_outbox (
        sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,event_id UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
        origin_id UUID NOT NULL,transaction_id TEXT NOT NULL,resource_kind TEXT NOT NULL,resource_id TEXT NOT NULL,
        revision BIGINT NOT NULL,target_table TEXT NOT NULL,target_id TEXT NOT NULL,operation TEXT NOT NULL,
        actor_id TEXT NOT NULL DEFAULT '',database_actor TEXT NOT NULL,request_id TEXT NOT NULL DEFAULT '',
        before_hash TEXT NOT NULL,after_hash TEXT NOT NULL,payload_json JSONB NOT NULL,
        credential_changed BOOLEAN NOT NULL DEFAULT FALSE,tombstone BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),journal_position BIGINT,acknowledged_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS analysis_security_inventory (
        table_name TEXT PRIMARY KEY,cursor_value TEXT NOT NULL DEFAULT '',scanned BIGINT NOT NULL DEFAULT 0,
        captured BIGINT NOT NULL DEFAULT 0,complete BOOLEAN NOT NULL DEFAULT FALSE,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
];

module.exports = [{
    id: '202611070009_analysis_security_journal',
    description: 'Capture minimal security changes and BI audit in a transactional outbox; require independent journal acknowledgement.',
    async upPg(client) {
        for (const sql of tables) await client.query(sql);
        await client.query("INSERT INTO analysis_security_state(id) VALUES ('main') ON CONFLICT(id) DO NOTHING");
        await client.query('CREATE INDEX IF NOT EXISTS idx_analysis_security_pending ON analysis_security_outbox(sequence) WHERE acknowledged_at IS NULL');
        await client.query('CREATE INDEX IF NOT EXISTS idx_analysis_security_transaction ON analysis_security_outbox(transaction_id) WHERE acknowledged_at IS NULL');
        await client.query("CREATE INDEX IF NOT EXISTS idx_analysis_security_resource_pending ON analysis_security_outbox((resource_kind||':'||resource_id)) WHERE acknowledged_at IS NULL");
        await client.query('CREATE INDEX IF NOT EXISTS idx_analysis_security_target ON analysis_security_outbox(target_table,target_id)');
        await client.query(`CREATE OR REPLACE FUNCTION analysis_security_snapshot(table_name TEXT,row_value JSONB) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $body$
            DECLARE result JSONB; keys TEXT[];
            BEGIN
                IF row_value IS NULL THEN RETURN NULL; END IF;
                keys := CASE table_name
                    WHEN 'users' THEN ARRAY['id','username','unit','role','status','deleted_at','token_version']
                    WHEN 'analysis_datasets' THEN ARRAY['id','user_id','scope','allowed_units','allowed_user_ids','status','deleted_at']
                    WHEN 'analysis_data_models' THEN ARRAY['id','user_id','scope','allowed_units','allowed_user_ids','archived_at','deleted_at']
                    WHEN 'analysis_field_governance' THEN ARRAY['id','dataset_id','user_id','field_key','logical_type','unit','date_format','sensitivity','status']
                    WHEN 'analysis_audit_events' THEN ARRAY['id','user_id','model_id','run_id','action','outcome','error_code','created_at']
                    WHEN 'analysis_saved_views' THEN ARRAY['id','user_id','scope','allowed_units','allowed_user_ids','deleted_at']
                    WHEN 'analysis_dashboards' THEN ARRAY['id','user_id','scope','allowed_units','allowed_user_ids','deleted_at']
                    WHEN 'analysis_metric_definitions' THEN ARRAY['id','user_id','scope','allowed_units','allowed_user_ids','deleted_at']
                    ELSE ARRAY[]::TEXT[] END;
                SELECT COALESCE(jsonb_object_agg(key,value),'{}') INTO result FROM jsonb_each(row_value) WHERE key=ANY(keys);
                IF table_name='analysis_datasets' THEN
                    result := result || jsonb_build_object('columnKeys',COALESCE((SELECT jsonb_agg(col->>'key' ORDER BY col->>'key') FROM jsonb_array_elements(COALESCE((row_value->>'columns_json')::jsonb,'[]')) col),'[]'));
                END IF;
                IF table_name='analysis_data_models' THEN
                    result := result || jsonb_build_object('definitionHash',encode(sha256(convert_to(COALESCE(row_value->>'definition_json',''),'UTF8')),'hex'));
                END IF;
                IF table_name='analysis_audit_events' THEN
                    result := result || jsonb_build_object('detailsHash',encode(sha256(convert_to(COALESCE(row_value->>'details_json',''),'UTF8')),'hex'));
                END IF;
                RETURN result;
            END $body$`);
        await client.query(`CREATE OR REPLACE FUNCTION analysis_capture_security_event() RETURNS trigger LANGUAGE plpgsql AS $body$
            DECLARE old_value JSONB; new_value JSONB; source JSONB; kind TEXT; resource TEXT; revision_value BIGINT; credential_change BOOLEAN;
            BEGIN
                IF current_setting('pivot.security_replay',TRUE)='on' THEN RETURN COALESCE(NEW,OLD); END IF;
                IF TG_OP='UPDATE' AND (to_jsonb(OLD)->>'id' IS DISTINCT FROM to_jsonb(NEW)->>'id' OR TG_TABLE_NAME='analysis_field_governance' AND to_jsonb(OLD)->>'dataset_id' IS DISTINCT FROM to_jsonb(NEW)->>'dataset_id')
                THEN RAISE EXCEPTION '安全资源标识和字段所属来源不可修改'; END IF;
                old_value := CASE WHEN TG_OP='INSERT' THEN NULL ELSE analysis_security_snapshot(TG_TABLE_NAME,to_jsonb(OLD)) END;
                new_value := CASE WHEN TG_OP='DELETE' THEN NULL ELSE analysis_security_snapshot(TG_TABLE_NAME,to_jsonb(NEW)) END;
                credential_change := TG_TABLE_NAME='users' AND TG_OP='UPDATE' AND to_jsonb(OLD)->>'password_hash' IS DISTINCT FROM to_jsonb(NEW)->>'password_hash';
                IF old_value IS NOT DISTINCT FROM new_value AND NOT credential_change THEN RETURN COALESCE(NEW,OLD); END IF;
                source := COALESCE(new_value,old_value);
                kind := CASE TG_TABLE_NAME WHEN 'users' THEN 'principal' WHEN 'analysis_data_models' THEN 'model' WHEN 'analysis_audit_events' THEN 'audit'
                    WHEN 'analysis_saved_views' THEN 'asset' WHEN 'analysis_dashboards' THEN 'asset' WHEN 'analysis_metric_definitions' THEN 'asset' ELSE 'dataset' END;
                resource := CASE WHEN kind='asset' THEN TG_TABLE_NAME||':'||(source->>'id') WHEN TG_TABLE_NAME='analysis_field_governance' THEN source->>'dataset_id' ELSE source->>'id' END;
                PERFORM pg_advisory_xact_lock(hashtext('pivot:analysis:authorization'),hashtext(kind||':'||resource));
                INSERT INTO analysis_security_revisions(resource_kind,resource_id,revision) VALUES (kind,resource,1)
                    ON CONFLICT(resource_kind,resource_id) DO UPDATE SET revision=analysis_security_revisions.revision+1 RETURNING revision INTO revision_value;
                INSERT INTO analysis_security_outbox(origin_id,transaction_id,resource_kind,resource_id,revision,target_table,target_id,operation,actor_id,database_actor,request_id,before_hash,after_hash,payload_json,credential_changed,tombstone)
                    SELECT origin_id,pg_current_xact_id()::text,kind,resource,revision_value,TG_TABLE_NAME,source->>'id',TG_OP,
                        COALESCE(current_setting('pivot.actor_id',TRUE),''),session_user,COALESCE(current_setting('pivot.request_id',TRUE),''),
                        encode(sha256(convert_to(COALESCE(old_value::text,'null'),'UTF8')),'hex'),encode(sha256(convert_to(COALESCE(new_value::text,'null'),'UTF8')),'hex'),
                        source,credential_change,TG_OP='DELETE' OR source->>'deleted_at' IS NOT NULL FROM analysis_security_state WHERE id='main';
                RETURN COALESCE(NEW,OLD);
            END $body$`);
        for (const table of ['users', 'analysis_datasets', 'analysis_data_models', 'analysis_field_governance', 'analysis_saved_views', 'analysis_dashboards', 'analysis_metric_definitions']) {
            await client.query(`DROP TRIGGER IF EXISTS analysis_security_event ON ${table}; CREATE TRIGGER analysis_security_event AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION analysis_capture_security_event()`);
        }
        await client.query(`CREATE OR REPLACE FUNCTION analysis_protect_security_outbox() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN
                IF current_setting('pivot.security_replay',TRUE)='on' THEN RETURN COALESCE(NEW,OLD); END IF;
                IF TG_OP='DELETE' OR (to_jsonb(NEW)-'acknowledged_at'-'journal_position') IS DISTINCT FROM (to_jsonb(OLD)-'acknowledged_at'-'journal_position')
                    OR OLD.acknowledged_at IS NOT NULL AND (NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at OR NEW.journal_position IS DISTINCT FROM OLD.journal_position)
                THEN RAISE EXCEPTION '安全事件内容及已确认高水位不可改写'; END IF;
                RETURN NEW;
            END $body$;
            DROP TRIGGER IF EXISTS analysis_security_outbox_immutable ON analysis_security_outbox;
            CREATE TRIGGER analysis_security_outbox_immutable BEFORE UPDATE OR DELETE ON analysis_security_outbox FOR EACH ROW EXECUTE FUNCTION analysis_protect_security_outbox()`);
        await client.query('DROP TRIGGER IF EXISTS analysis_security_event ON analysis_audit_events; CREATE TRIGGER analysis_security_event AFTER INSERT ON analysis_audit_events FOR EACH ROW EXECUTE FUNCTION analysis_capture_security_event()');
        // Backfill is separate, bounded and resumable after this short DDL commit.
        // The initializing gate cannot open until all cursors and ACKs finish.
        for (const table of ['users', 'analysis_datasets', 'analysis_data_models', 'analysis_field_governance', 'analysis_audit_events', 'analysis_saved_views', 'analysis_dashboards', 'analysis_metric_definitions']) await client.query('INSERT INTO analysis_security_inventory(table_name) VALUES ($1) ON CONFLICT(table_name) DO NOTHING', [table]);
    }
}];
