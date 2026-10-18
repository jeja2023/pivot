'use strict';

function snapshotError(message, code = 'MEMORY_EXPORT_SNAPSHOT_UNAVAILABLE', statusCode = 409) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function boundedPositive(value, fallback, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function createMemorySnapshotExporter({ transaction, serializeMemory, normalizeMemoryType, normalizeMemoryContent, memoryStatus, isLongTermMemoryEnabled, getTimestamp }) {
    return async function exportMemorySnapshot(userId, options = {}) {
        const maxRecords = boundedPositive(options.maxRecords, 10000, 100000);
        const status = String(options.status || memoryStatus.active);
        const type = options.type ? normalizeMemoryType(options.type) : '';
        const search = normalizeMemoryContent(options.search || '').slice(0, 120);
        const where = ['m.user_id = ?'];
        const params = [userId];
        if (status !== 'all') { where.push('m.status = ?'); params.push(status); }
        if (type) { where.push('m.type = ?'); params.push(type); }
        if (search) { where.push('(m.content LIKE ? OR m.source_session_id LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
        return await transaction(async trx => {
            // 必须是事务中的第一条业务读取，确保总数与每一条正文来自同一 PostgreSQL 快照。
            await trx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const totalRow = await trx.queryOne(`SELECT COUNT(*) AS count FROM memories m WHERE ${where.join(' AND ')}`, params);
            const total = Number(totalRow?.count || 0);
            if (!Number.isSafeInteger(total) || total < 0) throw snapshotError('长期记忆导出快照计数无效。');
            if (total > maxRecords) throw snapshotError(`长期记忆导出快照包含 ${total} 条记录，超过本次 ${maxRecords} 条上限；请先缩小筛选范围。`, 'MEMORY_EXPORT_SNAPSHOT_TOO_LARGE', 413);
            const rows = await trx.query(`
                SELECT m.*, EXISTS (
                    SELECT 1 FROM memory_source_evidence e WHERE e.memory_id = m.id AND e.user_id = m.user_id
                ) AS has_source_evidence
                FROM memories m
                WHERE ${where.join(' AND ')}
                ORDER BY CASE m.status WHEN 'active' THEN 0 ELSE 1 END, m.salience DESC,
                    COALESCE(m.last_used_at, m.updated_at, m.created_at) DESC, m.id DESC
            `, params);
            if (rows.length !== total) throw snapshotError('长期记忆导出快照行数不一致，请重试。');
            return {
                exportedAt: getTimestamp(), version: 3, total, startOffset: 0, complete: true, nextOffset: null,
                consistency: 'repeatable_read_snapshot', enabled: await isLongTermMemoryEnabled(userId), memories: rows.map(serializeMemory)
            };
        });
    };
}

module.exports = { createMemorySnapshotExporter };
