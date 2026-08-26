const { query } = require('../db/client');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { assertSafeModelRuntimeUrl, createSafeModelHttpAgents } = require('./model-adapter');
const { ConcurrencySemaphore, ConcurrencyLimitError } = require('./concurrency');
const { parsePositiveInt } = require('../number');
const { getModelEndpointRuntimeConfig } = require('./runtime-settings');
const { safeJsonGet } = require('./safe-http-client');

const FAILURE_THRESHOLD = parsePositiveInt(process.env.MODEL_ENDPOINT_FAILURE_THRESHOLD, 3);
const CIRCUIT_OPEN_MS = parsePositiveInt(process.env.MODEL_ENDPOINT_CIRCUIT_OPEN_MS, 60000);
const MONITOR_INTERVAL_MS = parsePositiveInt(process.env.MODEL_ENDPOINT_MONITOR_INTERVAL_MS, 30000);
const MONITOR_TIMEOUT_MS = parsePositiveInt(process.env.MODEL_ENDPOINT_MONITOR_TIMEOUT_MS, 5000);

const runtimes = new Map();
let monitorStarted = false;
let monitorRefreshPromise = null;
let monitorRefreshTimer = null;
let cachedActiveEndpointModels = [];

async function getActiveEndpointModelsAsync() {
    try {
        const rows = await query(`
            SELECT id, name, url, monitor_url, max_concurrent, supports_vision
            FROM models
            WHERE COALESCE(status, 'active') = 'active'
        `);
        cachedActiveEndpointModels = rows || [];
        return cachedActiveEndpointModels;
    } catch (e) {
        return cachedActiveEndpointModels;
    }
}

function getActiveEndpointModels() {
    return cachedActiveEndpointModels;
}

function normalizeEndpointKey(modelCfg) {
    try {
        const parsed = new URL(String(modelCfg?.url || '').trim());
        return `${parsed.protocol}//${parsed.host}`.toLowerCase();
    } catch (e) {
        return `model:${modelCfg?.id || 'unknown'}`;
    }
}

function getActiveEndpointModelsForKey(endpointKey) {
    return getActiveEndpointModels().filter(model => normalizeEndpointKey(model) === endpointKey);
}

function normalizeMaxConcurrent(modelCfg, runtimeConfig = getModelEndpointRuntimeConfig()) {
    return parsePositiveInt(modelCfg?.max_concurrent, runtimeConfig.defaultConcurrency);
}

function resolveEndpointMaxConcurrent(models = [], runtimeConfig = getModelEndpointRuntimeConfig()) {
    const defaultConcurrency = parsePositiveInt(runtimeConfig.defaultConcurrency, 1);
    const modelLimits = models.map(model => normalizeMaxConcurrent(model, runtimeConfig));
    return modelLimits.length ? Math.max(...modelLimits) : defaultConcurrency;
}

function getRuntimeModelsForKey(endpointKey, modelCfg) {
    const existing = runtimes.get(endpointKey);
    const existingModels = existing ? Array.from(existing.models.values()) : [];
    const candidates = getActiveEndpointModelsForKey(endpointKey).concat(existingModels, modelCfg).filter(Boolean);
    const byId = new Map();
    candidates.forEach((model, index) => {
        const id = model?.id === null || model?.id === undefined ? `inline:${index}` : String(model.id);
        byId.set(id, model);
    });
    return Array.from(byId.values());
}

function ensureRuntime(modelCfg, options = {}) {
    const key = normalizeEndpointKey(modelCfg);
    const runtimeConfig = options.runtimeConfig || getModelEndpointRuntimeConfig();
    const optionMax = Number.parseInt(options.maxConcurrent, 10);
    const maxConcurrent = Number.isFinite(optionMax) && optionMax > 0
        ? optionMax
        : resolveEndpointMaxConcurrent(getRuntimeModelsForKey(key, modelCfg), runtimeConfig);
    let runtime = runtimes.get(key);
    if (!runtime) {
        runtime = {
            key,
            name: modelCfg?.name || key,
            host: '',
            models: new Map(),
            semaphore: new ConcurrencySemaphore({
                maxConcurrent,
                maxQueueSize: runtimeConfig.queueSize,
                queueTimeoutMs: runtimeConfig.queueTimeoutMs
            }),
            configuredMaxConcurrent: maxConcurrent,
            consecutiveFailures: 0,
            circuitOpenUntil: 0,
            lastError: '',
            lastLatencyMs: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            requestCount: 0,
            errorCount: 0,
            monitor: {
                configured: false,
                url: '',
                status: 'unknown',
                updatedAt: null,
                latencyMs: null,
                error: '',
                payload: null
            }
        };
        try {
            runtime.host = new URL(String(modelCfg?.url || '').trim()).host;
        } catch (e) {
            runtime.host = key;
        }
        runtimes.set(key, runtime);
    }

    runtime.name = modelCfg?.name || runtime.name;
    runtime.configuredMaxConcurrent = maxConcurrent;
    runtime.semaphore.updateLimits({
        maxConcurrent,
        maxQueueSize: runtimeConfig.queueSize,
        queueTimeoutMs: runtimeConfig.queueTimeoutMs
    });
    runtime.models.set(String(modelCfg?.id || runtime.models.size), {
        id: modelCfg?.id,
        name: modelCfg?.name || '',
        monitor_url: modelCfg?.monitor_url || '',
        max_concurrent: modelCfg?.max_concurrent || 0,
        supports_vision: modelCfg?.supports_vision || 0
    });
    return runtime;
}

function syncConfiguredRuntimes(models = getActiveEndpointModels()) {
    const activeModelIdsByKey = new Map();
    const modelsByKey = new Map();

    models.forEach(model => {
        const key = normalizeEndpointKey(model);
        if (!activeModelIdsByKey.has(key)) {
            activeModelIdsByKey.set(key, new Set());
            modelsByKey.set(key, []);
        }
        activeModelIdsByKey.get(key).add(String(model.id));
        modelsByKey.get(key).push(model);
    });

    const runtimeConfig = getModelEndpointRuntimeConfig();
    for (const endpointModels of modelsByKey.values()) {
        const maxConcurrent = resolveEndpointMaxConcurrent(endpointModels, runtimeConfig);
        endpointModels.forEach(model => ensureRuntime(model, { runtimeConfig, maxConcurrent }));
    }

    for (const [key, runtime] of runtimes.entries()) {
        const activeModelIds = activeModelIdsByKey.get(key);
        if (!activeModelIds) {
            runtimes.delete(key);
            continue;
        }

        for (const modelId of runtime.models.keys()) {
            if (!activeModelIds.has(modelId)) {
                runtime.models.delete(modelId);
            }
        }

        if (runtime.models.size === 0) {
            runtimes.delete(key);
        }
    }
}
async function acquireModelSlot(modelCfg, options = {}) {
    const runtime = ensureRuntime(modelCfg);
    const now = Date.now();
    if (runtime.circuitOpenUntil > now) {
        const retrySeconds = Math.ceil((runtime.circuitOpenUntil - now) / 1000);
        throw new ConcurrencyLimitError(
            `模型端点暂时熔断，约 ${retrySeconds} 秒后可重试。${runtime.lastError || ''}`.trim(),
            'AI_ENDPOINT_CIRCUIT_OPEN'
        );
    }

    await runtime.semaphore.acquire(options);
    runtime.requestCount += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        runtime.semaphore.release();
    };
}

function recordModelSuccess(modelCfg, latencyMs) {
    const runtime = ensureRuntime(modelCfg);
    runtime.consecutiveFailures = 0;
    runtime.circuitOpenUntil = 0;
    runtime.lastError = '';
    runtime.lastLatencyMs = Number.isFinite(latencyMs) ? latencyMs : runtime.lastLatencyMs;
    runtime.lastSuccessAt = getBeijingTimestamp();
}

function recordModelFailure(modelCfg, err) {
    const runtime = ensureRuntime(modelCfg);
    runtime.consecutiveFailures += 1;
    runtime.errorCount += 1;
    runtime.lastError = err?.response?.data?.error?.message || err?.message || String(err || 'unknown error');
    runtime.lastFailureAt = getBeijingTimestamp();
    if (runtime.consecutiveFailures >= FAILURE_THRESHOLD) {
        runtime.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
        runtime.semaphore.rejectQueuedRequests(
            `模型端点连续失败，已熔断 ${Math.round(CIRCUIT_OPEN_MS / 1000)} 秒`,
            'AI_ENDPOINT_CIRCUIT_OPEN'
        );
        logger.warn({
            endpoint: runtime.key,
            failures: runtime.consecutiveFailures,
            error: runtime.lastError
        }, '模型端点已触发熔断保护');
    }
}

function compactPayload(data) {
    if (!data || typeof data !== 'object') return null;
    const payload = {};
    ['status', 'state', 'healthy', 'message', 'gpu', 'gpus', 'memory', 'vram', 'queue', 'concurrency'].forEach(key => {
        if (Object.prototype.hasOwnProperty.call(data, key)) payload[key] = data[key];
    });
    return Object.keys(payload).length ? payload : null;
}

async function refreshEndpointMonitor(runtime) {
    const model = Array.from(runtime.models.values()).find(item => item.monitor_url);
    runtime.monitor.configured = Boolean(model?.monitor_url);
    runtime.monitor.url = model?.monitor_url || '';
    if (!runtime.monitor.url) return runtime.monitor;

    const start = Date.now();
    try {
        const response = await safeJsonGet(runtime.monitor.url, {
            assertUrl: (url) => assertSafeModelRuntimeUrl(model, url),
            createAgents: () => createSafeModelHttpAgents(model),
            timeout: MONITOR_TIMEOUT_MS,
            validateStatus: status => status < 500
        });
        runtime.monitor.updatedAt = getBeijingTimestamp();
        runtime.monitor.latencyMs = Date.now() - start;
        runtime.monitor.error = '';
        runtime.monitor.payload = compactPayload(response.data);
        const rawStatus = response.data?.status || response.data?.state;
        const healthy = response.data?.healthy;
        runtime.monitor.status = response.status >= 400
            ? 'degraded'
            : (healthy === false ? 'degraded' : (rawStatus ? String(rawStatus) : 'ok'));
    } catch (e) {
        runtime.monitor.updatedAt = getBeijingTimestamp();
        runtime.monitor.latencyMs = Date.now() - start;
        runtime.monitor.status = 'unreachable';
        runtime.monitor.error = e.message || '监控请求失败';
        runtime.monitor.payload = null;
    }
    return runtime.monitor;
}

async function refreshAllEndpointMonitorsCore() {
    const models = await getActiveEndpointModelsAsync();
    syncConfiguredRuntimes(models);
    const jobs = Array.from(runtimes.values()).map(refreshEndpointMonitor);
    await Promise.allSettled(jobs);
}

function scheduleNextMonitorRefresh(delayMs = MONITOR_INTERVAL_MS) {
    if (monitorRefreshTimer) return;
    monitorRefreshTimer = setTimeout(() => {
        monitorRefreshTimer = null;
        runMonitorRefresh()
            .catch(err => {
                logger.warn({ err: err.message }, '模型端点刷新失败，已在下一轮重试');
            })
            .finally(() => {
                scheduleNextMonitorRefresh(MONITOR_INTERVAL_MS);
            });
    }, delayMs);
    monitorRefreshTimer.unref();
}

function runMonitorRefresh() {
    if (monitorRefreshPromise) return monitorRefreshPromise;
    monitorRefreshPromise = refreshAllEndpointMonitorsCore().finally(() => {
        monitorRefreshPromise = null;
    });
    return monitorRefreshPromise;
}

async function refreshAllEndpointMonitors() {
    return runMonitorRefresh();
}

async function startModelEndpointMonitor() {
    if (monitorStarted) return;
    monitorStarted = true;
    logger.info({ intervalMs: MONITOR_INTERVAL_MS }, '模型端点监控已启动');
    await runMonitorRefresh();
    scheduleNextMonitorRefresh();
}

function getModelEndpointRuntimeStatus(models) {
    if (Array.isArray(models)) {
        cachedActiveEndpointModels = models;
    }
    syncConfiguredRuntimes(models || getActiveEndpointModels());
    return Array.from(runtimes.values()).map(runtime => {
        const status = runtime.semaphore.getStatus();
        const circuitOpenMs = Math.max(0, runtime.circuitOpenUntil - Date.now());
        return {
            key: runtime.key,
            host: runtime.host,
            name: runtime.name,
            models: Array.from(runtime.models.values()),
            concurrency: status,
            configuredMaxConcurrent: runtime.configuredMaxConcurrent,
            consecutiveFailures: runtime.consecutiveFailures,
            circuitOpenMs,
            lastError: runtime.lastError,
            lastLatencyMs: runtime.lastLatencyMs,
            lastSuccessAt: runtime.lastSuccessAt,
            lastFailureAt: runtime.lastFailureAt,
            requestCount: runtime.requestCount,
            errorCount: runtime.errorCount,
            monitor: { ...runtime.monitor }
        };
    });
}

module.exports = {
    acquireModelSlot,
    recordModelSuccess,
    recordModelFailure,
    refreshAllEndpointMonitors,
    startModelEndpointMonitor,
    getModelEndpointRuntimeStatus,
    syncConfiguredRuntimes,
    normalizeEndpointKey
};

