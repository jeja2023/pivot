'use strict';
module.exports = [{
    id: '202611170001_common_recovery_web_local_helper',
    description: '为网页本机助手配对表补齐共同恢复语句级写入保护触发器。',
    async upPg(client) {
        await client.query(`DROP TRIGGER IF EXISTS pivot_common_recovery_write ON "web_local_helper_pairs";
            CREATE TRIGGER pivot_common_recovery_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "web_local_helper_pairs"
            FOR EACH STATEMENT EXECUTE FUNCTION pivot_common_recovery_write_barrier()`);
    }
}];
