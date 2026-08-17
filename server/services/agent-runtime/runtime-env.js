const crypto = require('crypto');
const { getAgentConcurrencyConfig } = require('../runtime-settings');

const AGENT_DEFAULT_TIMEOUT_MS = Math.max(Number.parseInt(process.env.AGENT_RUN_TIMEOUT_MS || '600000', 10) || 600000, 60000);
const AGENT_TOOL_TIMEOUT_MS = Math.max(Number.parseInt(process.env.AGENT_TOOL_TIMEOUT_MS || '120000', 10) || 120000, 30000);
const AGENT_STALE_RUNNING_MINUTES = Math.max(Number.parseInt(process.env.AGENT_STALE_RUNNING_MINUTES || '30', 10) || 30, 5);
const AGENT_QUEUE_LOCK_MS = Math.max(Number.parseInt(process.env.AGENT_QUEUE_LOCK_MS || `${24 * 60 * 60 * 1000}`, 10) || (24 * 60 * 60 * 1000), 60000);
const AGENT_INSTANCE_ID = process.env.PIVOT_INSTANCE_ID || `agent_${crypto.randomBytes(4).toString('hex')}`;

function getAgentMaxConcurrentRuns() {
    return getAgentConcurrencyConfig().maxConcurrentRuns;
}

function getAgentDagNodeConcurrency() {
    return getAgentConcurrencyConfig().dagNodeConcurrency;
}

function createRunId() {
    return `run_${crypto.randomBytes(12).toString('hex')}`;
}

function withTimeout(operation, timeoutMs, label = 'operation', options = {}) {
    const safeTimeout = Math.max(Number(timeoutMs) || 0, 1000);
    const timeoutCode = String(options?.timeoutCode || 'AGENT_TIMEOUT');
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const parentSignal = options?.signal || null;
        let settled = false;
        let abortReason = null;
        const finish = callback => value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            parentSignal?.removeEventListener?.('abort', onParentAbort);
            callback(value);
        };
        const onParentAbort = () => {
            const reason = parentSignal.reason instanceof Error ? parentSignal.reason : new Error('Operation aborted.');
            if (!reason.code) reason.code = 'AGENT_RUN_CANCELLED';
            abortReason = reason;
            controller.abort(reason);
            finish(reject)(reason);
        };
        const timer = setTimeout(() => {
            const err = new Error(`${label}执行超时`);
            err.code = timeoutCode;
            abortReason = err;
            controller.abort(err);
            finish(reject)(err);
        }, safeTimeout);
        if (parentSignal?.aborted) {
            onParentAbort();
            return;
        }
        parentSignal?.addEventListener?.('abort', onParentAbort, { once: true });
        Promise.resolve()
            .then(() => typeof operation === 'function' ? operation(controller.signal) : operation)
            .then(
                value => abortReason ? finish(reject)(abortReason) : finish(resolve)(value),
                error => finish(reject)(abortReason || error)
            );
    });
}

module.exports = {
    AGENT_DEFAULT_TIMEOUT_MS,
    AGENT_TOOL_TIMEOUT_MS,
    AGENT_STALE_RUNNING_MINUTES,
    AGENT_QUEUE_LOCK_MS,
    AGENT_INSTANCE_ID,
    getAgentMaxConcurrentRuns,
    getAgentDagNodeConcurrency,
    createRunId,
    withTimeout
};
