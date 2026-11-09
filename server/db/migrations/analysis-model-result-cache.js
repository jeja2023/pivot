'use strict';

module.exports = [{
    id: '202611070012_analysis_model_result_cache',
    description: '为当前用户和固定语义来源的结果缓存提供有界索引查询。',
    async upPg(client) {
        await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
        await client.query("CREATE INDEX IF NOT EXISTS idx_analysis_job_result_cache ON analysis_query_jobs(user_id,model_id,published_version,manifest_id,request_hash,completed_at DESC) WHERE execution_kind='model_query' AND status='succeeded'");
    },
    async checkPg(client) {
        // 名称回退或同名索引挂在其他表上，都不能证明当前查询表已完成迁移。
        const { rows } = await client.query(`SELECT indisvalid FROM pg_index
            WHERE indexrelid=to_regclass(format('%I.%I',current_schema(),'idx_analysis_job_result_cache'))
              AND indrelid=to_regclass(format('%I.%I',current_schema(),'analysis_query_jobs'))`);
        return rows.length === 1 && rows[0].indisvalid;
    }
}];
