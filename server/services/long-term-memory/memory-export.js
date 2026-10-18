'use strict';

function exportError(message, code = 'MEMORY_EXPORT_INCONSISTENT', statusCode = 409) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function boundedPositive(value, fallback, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function createMemoryExporter({ listMemories, getMemorySummary, getTimestamp }) {
    return async function exportMemories(userId, options = {}) {
        const pageSize = boundedPositive(options.pageSize || options.limit, 500, 500);
        const maxRecords = boundedPositive(options.maxRecords, 10000, 100000);
        const parsedOffset = options.offset == null || options.offset === '' ? 0 : Number(options.offset);
        if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0) {
            throw exportError('长期记忆导出偏移无效。', 'MEMORY_EXPORT_OFFSET_INVALID', 400);
        }

        const startOffset = parsedOffset;
        let offset = startOffset;
        let total = null;
        let enabled = true;
        const memories = [];
        const seen = new Set();
        while (memories.length < maxRecords) {
            const limit = Math.min(pageSize, maxRecords - memories.length);
            const listed = await listMemories(userId, {
                status: options.status || 'all', type: options.type || '', search: options.search || '', limit, offset
            });
            const currentTotal = Number(listed?.total);
            if (!Number.isSafeInteger(currentTotal) || currentTotal < 0 || !Array.isArray(listed?.memories)
                || listed.memories.length > limit || (listed.memories.length > 0 && offset + listed.memories.length > currentTotal)
                || (total !== null && currentTotal !== total)) {
                throw exportError('长期记忆导出期间数据发生变化，请重试。');
            }
            total = currentTotal;
            enabled = listed.enabled;
            for (const memory of listed.memories) {
                const id = memory?.id == null ? '' : String(memory.id);
                if (!id || seen.has(id)) throw exportError('长期记忆导出期间记录发生变化，请重试。');
                seen.add(id);
                memories.push(memory);
            }
            offset += listed.memories.length;
            if (offset >= total) break;
            if (listed.memories.length < limit) throw exportError('长期记忆导出分页不一致，请重试。');
        }
        const complete = offset >= total;
        return {
            exportedAt: getTimestamp(), version: 2, summary: await getMemorySummary(userId), enabled, total,
            startOffset, complete, nextOffset: complete ? null : offset, consistency: 'best_effort', memories
        };
    };
}

module.exports = { createMemoryExporter };
