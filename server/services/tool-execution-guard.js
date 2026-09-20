'use strict';

/**
 * Per-tool/per-connection bulkheads, rate limits and circuit breakers.
 *
 * This is deliberately process-local for latency and works alongside the
 * database-backed request limiter. It protects each worker immediately from a
 * noisy or failing downstream tool; a later shared limiter can replace this
 * leaf module without changing the Policy Engine API.
 */
const WINDOW_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_PER_TOOL = 4;
const DEFAULT_MAX_CALLS_PER_MINUTE = 120;
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_TRACKED_KEYS = 2_000;

function boundedInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function getToolExecutionGuardConfig(env = process.env) {
    return {
        maxConcurrentPerTool: boundedInt(env.PIVOT_TOOL_MAX_CONCURRENT_PER_TOOL, DEFAULT_MAX_CONCURRENT_PER_TOOL, 1, 100),
        maxCallsPerMinute: boundedInt(env.PIVOT_TOOL_MAX_CALLS_PER_MINUTE, DEFAULT_MAX_CALLS_PER_MINUTE, 1, 100_000),
        failureThreshold: boundedInt(env.PIVOT_TOOL_CIRCUIT_FAILURE_THRESHOLD, DEFAULT_FAILURE_THRESHOLD, 1, 100),
        cooldownMs: boundedInt(env.PIVOT_TOOL_CIRCUIT_COOLDOWN_MS, DEFAULT_COOLDOWN_MS, 1_000, 30 * 60 * 1000)
    };
}

function guardKey({ toolName = '', connectionAccountId = null, serverId = null } = {}) {
    const connection = connectionAccountId ? `connection:${connectionAccountId}` : serverId ? `server:${serverId}` : 'platform';
    return `${connection}|tool:${String(toolName || 'unknown').slice(0, 320)}`;
}

function transientError(error) {
    const code = String(error?.code || '').toUpperCase();
    const status = Number(error?.status || error?.response?.status || 0);
    return status === 429 || status >= 500 || ['ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'MCP_RESPONSE_TOO_LARGE'].includes(code);
}

function retryDelayMs(attempt, random = Math.random) {
    const base = Math.min(500 * (2 ** Math.max(Number(attempt) - 1, 0)), 8_000);
    return Math.round(base * (0.8 + Math.max(0, Math.min(Number(random()) || 0, 1)) * 0.4));
}

function guardError(message, code, status = 429) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.category = code === 'TOOL_CIRCUIT_OPEN' ? 'circuit' : code === 'TOOL_BULKHEAD_FULL' ? 'bulkhead' : 'rate_limit';
    return error;
}

function createToolExecutionGuard(options = {}) {
    const state = new Map();
    const getConfig = options.getConfig || getToolExecutionGuardConfig;
    const now = options.now || (() => Date.now());

    function entryFor(key) {
        if (!state.has(key)) {
            while (state.size >= MAX_TRACKED_KEYS) state.delete(state.keys().next().value);
            state.set(key, { inFlight: 0, windowStartedAt: now(), callsInWindow: 0, consecutiveFailures: 0, circuitOpenUntil: 0, halfOpenProbe: false, updatedAt: now() });
        }
        return state.get(key);
    }

    function acquire(input = {}) {
        const key = guardKey(input);
        const config = getConfig(input.env || process.env);
        const entry = entryFor(key);
        const current = now();
        if (current - entry.windowStartedAt >= WINDOW_MS) {
            entry.windowStartedAt = current;
            entry.callsInWindow = 0;
        }
        if (entry.circuitOpenUntil > current) throw guardError('工具服务暂时处于熔断保护中，请稍后重试。', 'TOOL_CIRCUIT_OPEN', 503);
        if (entry.circuitOpenUntil && entry.circuitOpenUntil <= current && entry.halfOpenProbe) throw guardError('工具服务正在进行恢复探测，请稍后重试。', 'TOOL_CIRCUIT_HALF_OPEN', 503);
        if (entry.circuitOpenUntil && entry.circuitOpenUntil <= current) entry.halfOpenProbe = true;
        if (entry.callsInWindow >= config.maxCallsPerMinute) throw guardError('该工具当前调用过于频繁，请稍后重试。', 'TOOL_RATE_LIMITED');
        if (entry.inFlight >= config.maxConcurrentPerTool) throw guardError('该工具当前并发已满，请稍后重试。', 'TOOL_BULKHEAD_FULL', 503);
        entry.inFlight += 1;
        entry.callsInWindow += 1;
        entry.updatedAt = current;
        let released = false;
        return {
            key,
            release({ error = null } = {}) {
                if (released) return;
                released = true;
                entry.inFlight = Math.max(entry.inFlight - 1, 0);
                entry.updatedAt = now();
                if (!error) {
                    entry.consecutiveFailures = 0;
                    entry.circuitOpenUntil = 0;
                    entry.halfOpenProbe = false;
                    return;
                }
                if (transientError(error)) {
                    entry.consecutiveFailures += 1;
                    if (entry.consecutiveFailures >= config.failureThreshold) {
                        entry.circuitOpenUntil = now() + config.cooldownMs;
                        entry.halfOpenProbe = false;
                    }
                } else {
                    entry.consecutiveFailures = 0;
                    entry.halfOpenProbe = false;
                }
            }
        };
    }

    function snapshot(input = {}) {
        if (input.key) return { ...(state.get(input.key) || {}) };
        return Object.fromEntries([...state.entries()].map(([key, value]) => [key, { ...value }]));
    }

    function reset() { state.clear(); }
    return { acquire, reset, snapshot };
}

async function executeWithRetry(executor, { retryable = false, maxAttempts = 1, signal = null, sleep = null, random = Math.random } = {}) {
    if (typeof executor !== 'function') throw new TypeError('工具重试执行器必须是函数。');
    const attempts = retryable ? Math.min(Math.max(Number(maxAttempts) || 1, 1), 4) : 1;
    let error;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        signal?.throwIfAborted?.();
        try { return await executor(attempt); }
        catch (caught) {
            error = caught;
            if (attempt >= attempts || !transientError(caught)) throw caught;
            const delay = retryDelayMs(attempt, random);
            if (typeof sleep === 'function') await sleep(delay);
            else await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw error;
}

const defaultGuard = createToolExecutionGuard();

module.exports = {
    createToolExecutionGuard,
    executeWithRetry,
    retryDelayMs,
    ...defaultGuard
};
