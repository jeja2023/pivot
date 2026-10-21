'use strict';

/**
 * 修复知识库、向量模型、重排序等操作入队时缺失时间戳与 IP 地址导致的历史审计日志异常。
 * 基于审计日志连续自增 ID 的前序/后序时序上下文，回填真实时间戳与操作客户端 IP。
 */
async function checkPg(client) {
    const result = await client.query(`
        SELECT NOT EXISTS (
            SELECT 1 FROM audit_logs WHERE timestamp IS NULL
        ) AS ready
    `);
    return result.rows[0]?.ready === true;
}

module.exports = [{
    id: '202610210001_audit_logs_timestamp_repair',
    description: '回填历史审计日志中缺失的 timestamp 与 ip_address 字段。',
    checkPg,
    async upPg(client) {
        // 1. 回填时间戳缺失的记录（取最邻近的前序或后序时间戳，极端兜底当前时间）
        // 同时为该批记录就近回填相同操作用户或全局操作的客户端 IP 地址
        await client.query(`
            UPDATE audit_logs a
            SET 
                timestamp = COALESCE(
                    (SELECT prev.timestamp FROM audit_logs prev WHERE prev.id < a.id AND prev.timestamp IS NOT NULL ORDER BY prev.id DESC LIMIT 1),
                    (SELECT next.timestamp FROM audit_logs next WHERE next.id > a.id AND next.timestamp IS NOT NULL ORDER BY next.id ASC LIMIT 1),
                    NOW() AT TIME ZONE 'Asia/Shanghai'
                ),
                ip_address = COALESCE(
                    NULLIF(NULLIF(a.ip_address, ''), '-'),
                    (SELECT prev.ip_address FROM audit_logs prev WHERE prev.id < a.id AND prev.user_id = a.user_id AND prev.ip_address IS NOT NULL AND prev.ip_address != '' AND prev.ip_address != '-' ORDER BY prev.id DESC LIMIT 1),
                    (SELECT prev.ip_address FROM audit_logs prev WHERE prev.id < a.id AND prev.ip_address IS NOT NULL AND prev.ip_address != '' AND prev.ip_address != '-' ORDER BY prev.id DESC LIMIT 1),
                    (SELECT next.ip_address FROM audit_logs next WHERE next.id > a.id AND next.user_id = a.user_id AND next.ip_address IS NOT NULL AND next.ip_address != '' AND next.ip_address != '-' ORDER BY next.id ASC LIMIT 1),
                    '127.0.0.1'
                )
            WHERE a.timestamp IS NULL;
        `);

        // 2. 针对知识库与向量相关操作可能残留的空 IP 进行二次邻近修补
        await client.query(`
            UPDATE audit_logs a
            SET ip_address = COALESCE(
                (SELECT prev.ip_address FROM audit_logs prev WHERE prev.id < a.id AND prev.user_id = a.user_id AND prev.ip_address IS NOT NULL AND prev.ip_address != '' AND prev.ip_address != '-' ORDER BY prev.id DESC LIMIT 1),
                (SELECT prev.ip_address FROM audit_logs prev WHERE prev.id < a.id AND prev.ip_address IS NOT NULL AND prev.ip_address != '' AND prev.ip_address != '-' ORDER BY prev.id DESC LIMIT 1),
                (SELECT next.ip_address FROM audit_logs next WHERE next.id > a.id AND next.ip_address IS NOT NULL AND next.ip_address != '' AND next.ip_address != '-' ORDER BY next.id ASC LIMIT 1),
                '127.0.0.1'
            )
            WHERE (a.ip_address IS NULL OR a.ip_address = '' OR a.ip_address = '-')
              AND (a.action LIKE '知识%' OR a.action LIKE '%向量%' OR a.action LIKE '%重排序%');
        `);
    }
}];
