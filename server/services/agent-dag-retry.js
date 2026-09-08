const { calculateAgentRetryDelayMs } = require('./agent-runtime/retry-policy');

function calculateDagRetryDelayMs(attempt) {
    // DAG 节点重试留出短暂退避，避免单个临时故障在同一秒内反复打满下游。
    return Math.max(250, Math.floor(calculateAgentRetryDelayMs(attempt) / 4));
}

function waitForDagRetry(delayMs, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason || new Error('任务已停止。'));
        const timer = setTimeout(done, Math.max(0, delayMs));
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
            reject(signal?.reason || new Error('任务已停止。'));
        };
        function done() {
            signal?.removeEventListener?.('abort', onAbort);
            resolve();
        }
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

module.exports = { calculateDagRetryDelayMs, waitForDagRetry };
