const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const vm = require('node:vm');

function loadModelRuntimeHarness({ pendingFirstRequest = false } = {}) {
    const filename = path.resolve(__dirname, '../server/services/model-runtime.js');
    const source = fs.readFileSync(filename, 'utf8');
    const module = { exports: {} };
    const localRequire = Module.createRequire(filename);
    const setTimeoutCalls = [];
    const setIntervalCalls = [];
    let axiosCalls = 0;
    let resolvePending = null;

    const fakeDb = {
        prepare(sql) {
            if (sql.includes('FROM models')) {
                return {
                    all() {
                        return [{
                            id: 1,
                            name: 'Model A',
                            url: 'https://api.example/v1',
                            monitor_url: 'https://monitor.example/status',
                            max_concurrent: 1,
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
            if (request === '../db') return { db: fakeDb };
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
                        constructor() {}
                        updateLimits() {}
                        getStatus() {
                            return {
                                active: 0,
                                queued: 0,
                                max: 1,
                                maxQueue: 1,
                                queueTimeoutMs: 1000,
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
            if (request === '../number') return { parsePositiveInt: (value, fallback) => Number.parseInt(value, 10) || fallback };
            if (request === './runtime-settings') {
                return {
                    getModelEndpointRuntimeConfig: () => ({
                        defaultConcurrency: 1,
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
