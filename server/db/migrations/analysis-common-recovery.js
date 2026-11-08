'use strict';

module.exports = [{
    id: '202611070010_analysis_common_recovery',
    description: 'Fence every shared-schema reference commit for short physical/common recovery points.',
    async upPg(client) {
        // A physical promotion changes the timeline even when the last
        // independent security event predates the restored point. Persisting
        // its accepted value closes reads until current-authority review.
        await client.query(`CREATE OR REPLACE FUNCTION pivot_current_database_timeline() RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER SET search_path=pg_catalog AS $body$
            SELECT CASE WHEN pg_is_in_recovery() THEN 0::BIGINT ELSE ('x'||substring(pg_walfile_name(pg_current_wal_insert_lsn()),1,8))::bit(32)::BIGINT END $body$`);
        await client.query(`CREATE OR REPLACE FUNCTION pivot_current_database_system_identifier() RETURNS TEXT LANGUAGE SQL SECURITY DEFINER SET search_path=pg_catalog AS $body$
            SELECT system_identifier::text FROM pg_control_system() $body$`);
        await client.query('ALTER TABLE analysis_security_state ADD COLUMN IF NOT EXISTS accepted_database_timeline BIGINT');
        await client.query('ALTER TABLE analysis_security_state ADD COLUMN IF NOT EXISTS accepted_database_system_identifier TEXT');
        // An already-enforced older DB has no trusted lineage marker. An
        // upgrade cannot distinguish a live original from an old logical
        // restore; require current-authority review once before accepting it.
        await client.query(`UPDATE analysis_security_state SET accepted_database_timeline=pivot_current_database_timeline(),
            accepted_database_system_identifier=pivot_current_database_system_identifier(),
            mode=CASE WHEN enforced THEN 'recovery_required' ELSE mode END,
            recovery_reason=CASE WHEN enforced THEN 'database_lineage_review_required' ELSE recovery_reason END,
            recovery_started_at=CASE WHEN enforced THEN COALESCE(recovery_started_at,NOW()) ELSE recovery_started_at END,
            pending_reconciliation_hash=CASE WHEN enforced THEN '' ELSE pending_reconciliation_hash END
            WHERE accepted_database_timeline IS NULL OR accepted_database_system_identifier IS NULL`);
        await client.query("ALTER TABLE analysis_recovery_points ADD COLUMN IF NOT EXISTS backup_id TEXT NOT NULL DEFAULT ''");
        await client.query('ALTER TABLE analysis_recovery_points ADD COLUMN IF NOT EXISTS barrier_ms BIGINT');
        await client.query("ALTER TABLE analysis_recovery_points ADD COLUMN IF NOT EXISTS failure_code TEXT NOT NULL DEFAULT ''");
        await client.query('ALTER TABLE analysis_recovery_points ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ');
        await client.query("CREATE INDEX IF NOT EXISTS idx_analysis_recovery_verified ON analysis_recovery_points(created_at DESC) WHERE status='verified'");
        await client.query(`CREATE OR REPLACE FUNCTION pivot_common_recovery_write_barrier() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN
                PERFORM pg_advisory_xact_lock_shared(hashtext('pivot:common-recovery'),hashtext(current_database()));
                RETURN NULL;
            END $body$`);
        // A statement trigger takes the shared gate before row/authorization
        // locks. All applications sharing the schema participate, including
        // direct SQL, bulk statements and truncation; not just BI writers.
        const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename");
        for (const { tablename } of tables.rows) {
            const quoted = '"' + tablename.replace(/"/g, '""') + '"';
            await client.query(`DROP TRIGGER IF EXISTS pivot_common_recovery_write ON ${quoted}; CREATE TRIGGER pivot_common_recovery_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${quoted} FOR EACH STATEMENT EXECUTE FUNCTION pivot_common_recovery_write_barrier()`);
        }
    }
}];
