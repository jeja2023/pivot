const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const vm = require('node:vm');

function loadModelRuntimeHarness({ pendingFirstRequest = false, defaultConcurrency = 1, modelMaxConcurrent = 1, models = null } = {}) {
    const filename = path.resolve(__dirname, '../server/services/model-runtime.js');
    const source = fs.readFileSync(filename, 'utf8');
    const module = { exports: {} };
    const localRequire = Module.createRequire(filename);
    const setTimeoutCalls = [];
    const setIntervalCalls = [];
    const semaphores = [];
    let axiosCalls = 0;
    let resolvePending = null;

    const fakeDb = {
        prepare(sql) {
            if (sql.includes('FROM models')) {
                return {
                    all() {
                        return models || [{
                            id: 1,
                            name: 'Model A',
                            url: 'https://api.example/v1',
                            monitor_url: 'https://monitor.example/status',
                            max_concurrent: modelMaxConcurrent,
                            supports_vision: 0,
                            status: 'active'
                        }];
                    }
                };
            }
            return {
                all() { return []; },
                get() { return null; },
                run() { return { changes: 0 }; }
            };
        }
    };

    const axios = {
        get: async () => {
            axiosCalls += 1;
            if (pendingFirstRequest && axiosCalls === 1) {
                return await new Promise(resolve => {
                    resolvePending = resolve;
                });
            }
            return { status: 200, data: { status: 'ok', healthy: true } };
        }
    };

    const context = {
        module,
        exports: module.exports,
        require: (request) => {
            if (request === 'axios') return axios;
            if (request === '../db/client') {
                return {
                    query: async (sql) => fakeDb.prepare(sql).all(),
                    queryOne: async (sql) => fakeDb.prepare(sql).get(),
                    execute: async (sql) => fakeDb.prepare(sql).run().changes
                };
            }
            if (request === '../logger') return { logger: { info() {}, warn() {}, error() {} } };
            if (request === '../time') return { getBeijingTimestamp: () => '2026-06-26 00:00:00' };
            if (request === './model-adapter') {
                return {
                    assertSafeModelRuntimeUrl: async () => {},
                    createSafeModelHttpAgents: () => ({})
                };
            }
            if (request === './concurrency') {
                return {
                    ConcurrencySemaphore: class {
                        constructor(options = {}) {
                            this.maxConcurrent = options.maxConcurrent || 1;
                            this.maxQueueSize = options.maxQueueSize || 1;
                            this.queueTimeoutMs = options.queueTimeoutMs || 1000;
                            semaphores.push(this);
                        }
                        updateLimits(options = {}) {
                            if (Number.isFinite(Number(options.maxConcurrent)) && Number(options.maxConcurrent) > 0) {
                                this.maxConcurrent = Number(options.maxConcurrent);
                            }
                            if (Number.isFinite(Number(options.maxQueueSize)) && Number(options.maxQueueSize) >= 0) {
                                this.maxQueueSize = Number(options.maxQueueSize);
                            }
                            if (Number.isFinite(Number(options.queueTimeoutMs)) && Number(options.queueTimeoutMs) >= 1000) {
                                this.queueTimeoutMs = Number(options.queueTimeoutMs);
                            }
                        }
                        getStatus() {
                            return {
                                active: 0,
                                queued: 0,
                                max: this.maxConcurrent,
                                maxQueue: this.maxQueueSize,
                                queueTimeoutMs: this.queueTimeoutMs,
                                rejectingNewRequests: false,
                                rejectReason: '',
                                oldestQueuedMs: 0
                            };
                        }
                        release() {}
                        acquire() { return Promise.resolve(); }
                        rejectQueuedRequests() { return 0; }
                    },
                    ConcurrencyLimitError: class extends Error {}
                };
            }
            if (request === './observability') return { recordSlowModelResponse() {} };
            if (request === './safe-http-client') return { safeJsonGet: async (url, options = {}) => axios.get(url, options) };
            if (request === '../number') return { parsePositiveInt: (value, fallback) => Number.parseInt(value, 10) || fallback };
            if (request === './runtime-settings') {
                return {
                    getModelEndpointRuntimeConfig: () => ({
                        defaultConcurrency,
                        queueSize: 1,
                        queueTimeoutMs: 1000
                    })
                };
            }
            return localRequire(request);
        },
        console,
        process,
        Buffer,
        URL,
        setTimeout(fn, delay) {
            const timer = {
                fn,
                delay,
                unref() { return this; }
            };
            setTimeoutCalls.push(timer);
            return timer;
        },
        clearTimeout() {},
        setInterval(fn, delay) {
            const timer = {
                fn,
                delay,
                unref() { return this; }
            };
            setIntervalCalls.push(timer);
            return timer;
        },
        clearInterval() {}
    };

    vm.runInNewContext(source, context, { filename });

    return {
        runtime: module.exports,
        getAxiosCalls: () => axiosCalls,
        getPendingResolve: () => resolvePending,
        getSemaphores: () => semaphores,
        setTimeoutCalls,
        setIntervalCalls
    };
}

async function waitForFirstAxiosCall(getAxiosCalls, attempts = 5) {
    for (let i = 0; i < attempts && getAxiosCalls() === 0; i += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

test('model runtime coalesces overlapping refreshes into one request', async () => {
    const { runtime, getAxiosCalls, getPendingResolve } = loadModelRuntimeHarness({ pendingFirstRequest: true });
    const first = runtime.refreshAllEndpointMonitors();
    const second = runtime.refreshAllEndpointMonitors();
    await waitForFirstAxiosCall(getAxiosCalls);
    assert.equal(getAxiosCalls(), 1);
    const pending = getPendingResolve();
    assert.equal(typeof pending, 'function');
    pending({ status: 200, data: { status: 'ok', healthy: true } });
    await Promise.all([first, second]);
    assert.equal(getAxiosCalls(), 1);
});

test('model runtime starts monitor loop with setTimeout only', async () => {
    const { runtime, setTimeoutCalls, setIntervalCalls } = loadModelRuntimeHarness();
    await runtime.startModelEndpointMonitor();
    assert.equal(setIntervalCalls.length, 0);
    assert.equal(setTimeoutCalls.length, 1);
});

test('model runtime uses runtime default concurrency when model endpoint does not override it', async () => {
    const { runtime } = loadModelRuntimeHarness({ defaultConcurrency: 2, modelMaxConcurrent: 0 });
    await runtime.refreshAllEndpointMonitors();
    const status = runtime.getModelEndpointRuntimeStatus();
    assert.equal(status.length, 1);
    assert.equal(status[0].configuredMaxConcurrent, 2);
    assert.equal(status[0].concurrency.max, 2);
});

test('model runtime keeps shared endpoint at saved runtime concurrency when one model has a lower override', async () => {
    const { runtime } = loadModelRuntimeHarness({
        defaultConcurrency: 2,
        models: [
            {
                id: 1,
                name: 'Model A',
                url: 'https://api.example/v1',
                monitor_url: 'https://monitor.example/status',
                max_concurrent: 0,
                supports_vision: 0,
                status: 'active'
            },
            {
                id: 2,
                name: 'Model B',
                url: 'https://api.example/v1',
                monitor_url: '',
                max_concurrent: 1,
                supports_vision: 0,
                status: 'active'
            }
        ]
    });
    await runtime.refreshAllEndpointMonitors();
    const status = runtime.getModelEndpointRuntimeStatus();
    assert.equal(status.length, 1);
    assert.equal(status[0].models.length, 2);
    assert.equal(status[0].configuredMaxConcurrent, 2);
    assert.equal(status[0].concurrency.max, 2);
});

test('model runtime request path preserves shared endpoint max while active rows are briefly incomplete', async () => {
    const highModel = {
        id: 1,
        name: 'Model A',
        url: 'https://api.example/v1',
        monitor_url: 'https://monitor.example/status',
        max_concurrent: 0,
        supports_vision: 0,
        status: 'active'
    };
    const lowModel = {
        id: 2,
        name: 'Model B',
        url: 'https://api.example/v1',
        monitor_url: '',
        max_concurrent: 1,
        supports_vision: 0,
        status: 'active'
    };
    const activeModels = [highModel, lowModel];
    const { runtime, getSemaphores } = loadModelRuntimeHarness({
        defaultConcurrency: 2,
        models: activeModels
    });

    await runtime.refreshAllEndpointMonitors();
    const initialStatus = runtime.getModelEndpointRuntimeStatus();
    assert.equal(initialStatus[0].concurrency.max, 2);
    assert.equal(getSemaphores()[0].maxConcurrent, 2);

    activeModels.splice(0, activeModels.length, lowModel);
    const release = await runtime.acquireModelSlot(lowModel);
    release();

    assert.equal(getSemaphores()[0].maxConcurrent, 2);
});
