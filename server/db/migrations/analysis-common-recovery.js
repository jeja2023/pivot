'use strict';

module.exports = [{
    id: '202611070010_analysis_common_recovery',
    description: 'Fence every shared-schema reference commit for short physical/common recovery points.',
    async upPg(client) {
        // 即使最后一条独立安全事件早于恢复时间点，物理提升也会改变时间线；
        // 持久化已接受值并关闭读取，直到当前授权复核完成。

        await client.query(`CREATE OR REPLACE FUNCTION pivot_current_database_timeline() RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER SET search_path=pg_catalog AS $body$
            SELECT CASE WHEN pg_is_in_recovery() THEN 0::BIGINT ELSE ('x'||substring(pg_walfile_name(pg_current_wal_insert_lsn()),1,8))::bit(32)::BIGINT END $body$`);
        await client.query(`CREATE OR REPLACE FUNCTION pivot_current_database_system_identifier() RETURNS TEXT LANGUAGE SQL SECURITY DEFINER SET search_path=pg_catalog AS $body$
            SELECT system_identifier::text FROM pg_control_system() $body$`);
        await client.query('ALTER TABLE analysis_security_state ADD COLUMN IF NOT EXISTS accepted_database_timeline BIGINT');
        await client.query('ALTER TABLE analysis_security_state ADD COLUMN IF NOT EXISTS accepted_database_system_identifier TEXT');
        // 已强制执行的旧数据库缺少受信任的血缘标记；升级时无法区分在线原始实例与旧逻辑恢复，
        // 在接受前须经当前授权复核一次。

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
        // 语句触发器在行锁与授权锁之前获取共享屏障；所有共享该 Schema 的应用共同参与
        // （含直接 SQL、批量操作和截断，不限于 BI 写入方）。

        const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename");
        for (const { tablename } of tables.rows) {
            const quoted = '"' + tablename.replace(/"/g, '""') + '"';
            await client.query(`DROP TRIGGER IF EXISTS pivot_common_recovery_write ON ${quoted}; CREATE TRIGGER pivot_common_recovery_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${quoted} FOR EACH STATEMENT EXECUTE FUNCTION pivot_common_recovery_write_barrier()`);
        }
    }
}];
