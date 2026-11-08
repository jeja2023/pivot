'use strict';

module.exports = [{
    id: '202611070007_analysis_authorization_fences',
    description: 'Backfill authorization revisions before enforcing fail-closed delivery fences.',
    async upPg(client) {
        // 旧记录在启用触发器前已存在；只补缺失项，不能降低已经递增的授权修订。
        await client.query(`INSERT INTO analysis_authorization_revisions(resource_kind,resource_id,revision)
            SELECT 'principal',id::text,1 FROM users
            UNION ALL SELECT 'dataset',id,1 FROM analysis_datasets
            UNION ALL SELECT 'model',id,1 FROM analysis_data_models
            ON CONFLICT(resource_kind,resource_id) DO NOTHING`);
        await client.query(`CREATE OR REPLACE FUNCTION analysis_protect_execution_claim() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN
                IF NEW.runtime_protocol>=2 AND NEW.status='running' AND
                    (OLD.status<>'running' OR NEW.attempts IS DISTINCT FROM OLD.attempts OR NEW.execution_epoch IS DISTINCT FROM OLD.execution_epoch OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner) AND
                    (OLD.status NOT IN ('queued','retry_wait') OR NEW.execution_epoch<>OLD.execution_epoch+1 OR NEW.attempts<>OLD.attempts+1 OR
                     COALESCE(NEW.lease_owner,'')='' OR NEW.slot_id IS NULL OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at<=NOW() OR NEW.execution_deadline_at IS NULL OR NEW.execution_deadline_at<=NOW())
                THEN RAISE EXCEPTION '旧执行器不能领取正式协议任务，请先升级并完成就绪检查'; END IF;
                RETURN NEW;
            END $body$;
            DROP TRIGGER IF EXISTS analysis_query_claim_contract ON analysis_query_jobs;
            CREATE TRIGGER analysis_query_claim_contract BEFORE UPDATE ON analysis_query_jobs FOR EACH ROW EXECUTE FUNCTION analysis_protect_execution_claim()`);
    }
}];
