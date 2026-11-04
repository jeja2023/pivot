const { normalizeToolConcurrency } = require('./agent-contracts');

const DEFAULT_READ_CONCURRENCY = Math.min(Math.max(Number(process.env.AGENT_STREAMING_READ_CONCURRENCY || 4) || 4, 1), 16);

function getToolConcurrency(tool = {}) {
    return normalizeToolConcurrency(tool.concurrency, Boolean(tool.side_effect ?? tool.sideEffect));
}

function cancellationError() {
    const error = new Error('智能体任务已取消。');
    error.code = 'AGENT_RUN_CANCELLED';
    return error;
}

async function runReadBatch(entries, runOne, options = {}) {
    const concurrency = Math.min(Math.max(Number(options.maxReadConcurrency) || DEFAULT_READ_CONCURRENCY, 1), 16);
    const results = new Array(entries.length);
    let nextIndex = 0;
    let failed = false, firstError;
    const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
        while (true) {
            if (failed) return;
            if (options.signal?.aborted) { failed = true; firstError = cancellationError(); return; }
            const index = nextIndex;
            nextIndex += 1;
            if (index >= entries.length) return;
            try { results[index] = await runOne(entries[index], index); }
            catch (error) { if (!failed) { failed = true; firstError = error; } return; }
        }
    });
    await Promise.all(workers);
    // 等待已开始的调用全部结束再交还控制权，避免旧批次与下一轮并发执行。
    if (failed) throw firstError;
    return results;
}

/**
 * Execute consecutive read-only calls in parallel while preserving the original result order.
 * Write and exclusive calls form a barrier so side effects cannot leapfrog each other.
 */
async function executeToolCallsInOrder(entries = [], runOne, options = {}) {
    const source = Array.isArray(entries) ? entries : [];
    const results = new Array(source.length);
    let cursor = 0;
    while (cursor < source.length) {
        if (options.signal?.aborted) throw cancellationError();
        const current = source[cursor];
        if (getToolConcurrency(current?.tool || current) !== 'read') {
            results[cursor] = await runOne(current, cursor);
            cursor += 1;
            continue;
        }
        const start = cursor;
        while (cursor < source.length && getToolConcurrency(source[cursor]?.tool || source[cursor]) === 'read') cursor += 1;
        const batch = await runReadBatch(source.slice(start, cursor), runOne, options);
        batch.forEach((result, index) => { results[start + index] = result; });
    }
    return results;
}

module.exports = {
    DEFAULT_READ_CONCURRENCY,
    executeToolCallsInOrder,
    getToolConcurrency
};
