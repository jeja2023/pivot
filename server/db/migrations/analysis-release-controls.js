'use strict';

module.exports = [{
    id: '202611070011_analysis_release_controls',
    description: 'Persist release switches and enforce admission/publication/claim boundaries for current and old clients.',
    async upPg(client) {
        await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
        await client.query('ALTER TABLE analysis_operation_state ADD COLUMN IF NOT EXISTS create_enabled BOOLEAN NOT NULL DEFAULT TRUE');
        await client.query('ALTER TABLE analysis_operation_state ADD COLUMN IF NOT EXISTS publish_enabled BOOLEAN NOT NULL DEFAULT TRUE');
        await client.query('ALTER TABLE analysis_operation_state ADD COLUMN IF NOT EXISTS admission_enabled BOOLEAN NOT NULL DEFAULT TRUE');
        await client.query('ALTER TABLE analysis_operation_state ADD COLUMN IF NOT EXISTS dispatch_enabled BOOLEAN NOT NULL DEFAULT TRUE');
        await client.query('ALTER TABLE analysis_operation_state ADD COLUMN IF NOT EXISTS release_revision BIGINT NOT NULL DEFAULT 1 CHECK(release_revision>0)');
        await client.query('ALTER TABLE analysis_operation_state ADD COLUMN IF NOT EXISTS release_actor BIGINT REFERENCES users(id) ON DELETE SET NULL');
        await client.query("ALTER TABLE analysis_operation_state ADD COLUMN IF NOT EXISTS release_reason TEXT NOT NULL DEFAULT ''");
        await client.query(`CREATE OR REPLACE FUNCTION analysis_release_switch_lock() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN
                PERFORM pg_advisory_xact_lock_shared(hashtext('pivot:common-recovery'),hashtext(current_database()));
                PERFORM pg_advisory_xact_lock(hashtext('pivot:analysis:release'),hashtext(current_database()||':'||current_schema()));
                RETURN NULL;
            END $body$;
            DROP TRIGGER IF EXISTS analysis_release_switch_lock ON analysis_operation_state;
            CREATE TRIGGER analysis_release_switch_lock BEFORE UPDATE OF create_enabled,publish_enabled,admission_enabled,dispatch_enabled ON analysis_operation_state
                FOR EACH STATEMENT EXECUTE FUNCTION analysis_release_switch_lock()`);
        await client.query(`CREATE OR REPLACE FUNCTION analysis_release_switch_revision() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN
                IF ROW(NEW.create_enabled,NEW.publish_enabled,NEW.admission_enabled,NEW.dispatch_enabled) IS DISTINCT FROM
                   ROW(OLD.create_enabled,OLD.publish_enabled,OLD.admission_enabled,OLD.dispatch_enabled) THEN
                    NEW.release_revision:=OLD.release_revision+1;
                    NEW.updated_at:=NOW();
                ELSIF NEW.release_revision IS DISTINCT FROM OLD.release_revision THEN
                    RAISE EXCEPTION '发布控制修订号只能随控制状态递增';
                END IF;
                RETURN NEW;
            END $body$;
            DROP TRIGGER IF EXISTS analysis_release_switch_revision ON analysis_operation_state;
            CREATE TRIGGER analysis_release_switch_revision BEFORE UPDATE ON analysis_operation_state FOR EACH ROW EXECUTE FUNCTION analysis_release_switch_revision()`);
        await client.query(`CREATE OR REPLACE FUNCTION analysis_release_transaction_lock() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN
                PERFORM pg_advisory_xact_lock_shared(hashtext('pivot:common-recovery'),hashtext(current_database()));
                PERFORM pg_advisory_xact_lock_shared(hashtext('pivot:analysis:release'),hashtext(current_database()||':'||current_schema()));
                RETURN NULL;
            END $body$`);
        for (const table of ['analysis_data_models', 'analysis_data_model_versions', 'analysis_query_jobs']) {
            await client.query(`DROP TRIGGER IF EXISTS analysis_release_transaction_lock ON ${table};
                CREATE TRIGGER analysis_release_transaction_lock BEFORE INSERT OR UPDATE OR DELETE ON ${table}
                FOR EACH STATEMENT EXECUTE FUNCTION analysis_release_transaction_lock()`);
        }
        await client.query(`CREATE OR REPLACE FUNCTION analysis_release_write_guard() RETURNS trigger LANGUAGE plpgsql AS $body$
            DECLARE controls RECORD; creating BOOLEAN:=FALSE; publishing BOOLEAN:=FALSE; claiming BOOLEAN:=FALSE;
            BEGIN
                IF TG_TABLE_NAME='analysis_data_models' THEN
                    IF TG_OP='INSERT' THEN
                        creating:=NEW.model_kind='production';
                        publishing:=NEW.model_kind='production' AND NEW.published_version IS NOT NULL;
                    ELSE
                        creating:=NEW.model_kind='production' AND OLD.model_kind IS DISTINCT FROM NEW.model_kind;
                        publishing:=NEW.model_kind='production' AND NEW.published_version IS DISTINCT FROM OLD.published_version AND NEW.published_version IS NOT NULL;
                    END IF;
                    IF NOT creating AND NOT publishing THEN RETURN NEW; END IF;
                ELSIF TG_TABLE_NAME='analysis_data_model_versions' THEN publishing:=TRUE;
                ELSIF TG_TABLE_NAME='analysis_query_jobs' THEN
                    IF TG_OP='INSERT' THEN claiming:=NEW.status='running';
                    ELSE
                        claiming:=NEW.status='running' AND (OLD.status<>'running' OR NEW.execution_epoch IS DISTINCT FROM OLD.execution_epoch OR NEW.attempts IS DISTINCT FROM OLD.attempts OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner);
                        IF NOT claiming THEN RETURN NEW; END IF;
                    END IF;
                END IF;
                PERFORM pg_advisory_xact_lock_shared(hashtext('pivot:analysis:release'),hashtext(current_database()||':'||current_schema()));
                SELECT create_enabled,publish_enabled,admission_enabled,dispatch_enabled INTO controls FROM analysis_operation_state WHERE id='main';
                IF NOT FOUND THEN RAISE EXCEPTION 'ANALYSIS_RELEASE_CONTROL_UNAVAILABLE: 发布控制缺失，请完成迁移'; END IF;
                IF creating AND NOT controls.create_enabled THEN RAISE EXCEPTION 'ANALYSIS_RELEASE_CREATE_PAUSED: 维护期间暂不接收新建正式模型'; END IF;
                IF publishing AND NOT controls.publish_enabled THEN RAISE EXCEPTION 'ANALYSIS_RELEASE_PUBLISH_PAUSED: 维护期间暂不接收模型发布或版本切换'; END IF;
                IF TG_TABLE_NAME='analysis_query_jobs' AND TG_OP='INSERT' AND NOT controls.admission_enabled THEN RAISE EXCEPTION 'ANALYSIS_RELEASE_ADMISSION_PAUSED: 维护期间暂不接收新的分析任务'; END IF;
                IF claiming AND NOT controls.dispatch_enabled THEN RAISE EXCEPTION 'ANALYSIS_RELEASE_DISPATCH_PAUSED: 维护期间暂不领取分析任务'; END IF;
                RETURN NEW;
            END $body$;
            DROP TRIGGER IF EXISTS analysis_release_model_write ON analysis_data_models;
            CREATE TRIGGER analysis_release_model_write BEFORE INSERT OR UPDATE ON analysis_data_models FOR EACH ROW EXECUTE FUNCTION analysis_release_write_guard();
            DROP TRIGGER IF EXISTS analysis_release_version_write ON analysis_data_model_versions;
            CREATE TRIGGER analysis_release_version_write BEFORE INSERT ON analysis_data_model_versions FOR EACH ROW EXECUTE FUNCTION analysis_release_write_guard();
            DROP TRIGGER IF EXISTS analysis_release_job_write ON analysis_query_jobs;
            CREATE TRIGGER analysis_release_job_write BEFORE INSERT OR UPDATE ON analysis_query_jobs FOR EACH ROW EXECUTE FUNCTION analysis_release_write_guard()`);
    },
    async checkPg(client) {
        const { rows } = await client.query(`SELECT
            (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='analysis_operation_state' AND column_name IN ('create_enabled','publish_enabled','admission_enabled','dispatch_enabled','release_revision','release_actor','release_reason')) AS fields,
            (SELECT COUNT(*) FROM pg_trigger WHERE tgname='analysis_release_transaction_lock' AND tgrelid IN (to_regclass('analysis_data_models'),to_regclass('analysis_data_model_versions'),to_regclass('analysis_query_jobs')) AND tgenabled='O' AND tgtype=30) AS locks,
            (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('analysis_release_model_write','analysis_release_version_write','analysis_release_job_write','analysis_release_switch_lock','analysis_release_switch_revision') AND tgrelid IN (to_regclass('analysis_data_models'),to_regclass('analysis_data_model_versions'),to_regclass('analysis_query_jobs'),to_regclass('analysis_operation_state')) AND tgenabled='O') AS guards`);
        return Number(rows[0].fields) === 7 && Number(rows[0].locks) === 3 && Number(rows[0].guards) === 5;
    }
}];
