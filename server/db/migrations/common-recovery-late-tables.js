'use strict';
module.exports = [{
    id: '202611100003_common_recovery_late_tables',
    description: '为共同恢复屏障之后引入的项目及 PPT 原稿表补齐语句级写入保护。',
    async upPg(client) {
        // 只补本次明确审核的新增表，不自动修复其他缺失保护，也不开放恢复状态。
        for (const table of ['agent_projects', 'presentation_native_documents', 'presentation_native_versions']) {
            await client.query(`DROP TRIGGER IF EXISTS pivot_common_recovery_write ON "${table}";
                CREATE TRIGGER pivot_common_recovery_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "${table}"
                FOR EACH STATEMENT EXECUTE FUNCTION pivot_common_recovery_write_barrier()`);
        }
    }
}];
