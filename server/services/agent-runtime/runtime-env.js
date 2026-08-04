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

function withTimeout(promise, timeoutMs, label = 'operation') {
    const safeTimeout = Math.max(Number(timeoutMs) || 0, 1000);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const err = new Error(`${label}执行超时`);
            err.code = 'AGENT_TIMEOUT';
            reject(err);
        }, safeTimeout);
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            err => {
                clearTimeout(timer);
                reject(err);
            }
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
