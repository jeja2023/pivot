'use strict';

// 向量服务故障不应在每次重启后无限尝试。法规版本保存索引重试状态、次数和下次
// 尝试时间；失败后仍保留关键词检索，管理员可手动重新排队。
module.exports = [{
    id: '202610120008_regulations_index_retries',
    description: 'Add bounded retry metadata for regulation vector indexing.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS index_attempts BIGINT NOT NULL DEFAULT 0;
            ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS index_max_attempts BIGINT NOT NULL DEFAULT 5;
            ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS index_next_retry_at TIMESTAMPTZ;
            ALTER TABLE regulation_versions ADD COLUMN IF NOT EXISTS index_last_attempt_at TIMESTAMPTZ;
            CREATE INDEX IF NOT EXISTS idx_regulation_versions_index_retry
                ON regulation_versions(index_status, index_next_retry_at, index_attempts);
        `);
    }
}];
