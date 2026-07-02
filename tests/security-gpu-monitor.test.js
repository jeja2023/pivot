const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const vm = require('node:vm');

function loadGpuMonitorHarness({ configuredMax = 2, initialMax = 2, execOutputs = [] } = {}) {
    const filename = path.resolve(__dirname, '../server/services/gpu-monitor.js');
    const source = fs.readFileSync(filename, 'utf8');
    const module = { exports: {} };
    const localRequire = Module.createRequire(filename);
    const updates = [];
    let maxConcurrent = initialMax;
    const rejecting = [];

    const aiSemaphore = {
        getStatus() {
            return {
                active: 0,
                queued: 0,
                max: maxConcurrent,
                maxQueue: 20,
                queueTimeoutMs: 300000,
                rejectingNewRequests: false,
                rejectReason: '',
                oldestQueuedMs: 0
            };
        },
        updateMaxConcurrent(nextMax) {
            maxConcurrent = Number(nextMax);
            updates.push(maxConcurrent);
        },
        setRejectingNewRequests(enabled, reason = '') {
            rejecting.push({ enabled: Boolean(enabled), reason });
        },
        rejectQueuedRequests() {
            return 0;
        }
    };

    const context = {
        module,
        exports: module.exports,
        require: (request) => {
            if (request === 'child_process') {
                return {
                    exec(_command, _options, callback) {
                        if (!execOutputs.length) throw new Error('No fake GPU output left');
                        const next = execOutputs.shift();
                        if (next instanceof Error) {
                            callback(next, '');
                        } else {
                            callback(null, next);
                        }
                        return { kill() {} };
                    }
                };
            }
            if (request === './concurrency') return { aiSemaphore };
            if (request === '../logger') return { logger: { info() {}, warn() {}, error() {} } };
            if (request === '../time') return { getBeijingTimestamp: () => '2026-07-02 12:00:00' };
            if (request === '../number') return { parsePositiveInt: (value, fallback) => Number.parseInt(value, 10) || fallback };
            if (request === './runtime-settings') {
                return {
                    getGlobalAiConcurrencyConfig: () => ({
                        maxConcurrent: configuredMax,
                        maxQueueSize: 20,
                        queueTimeoutMs: 300000
                    })
                };
            }
            return localRequire(request);
        },
        console,
        Buffer,
        process: {
            env: {
                GPU_CONCURRENT_MIN: '1',
                GPU_CONCURRENT_MAX: '4',
                GPU_VRAM_SAFE_THRESHOLD: '0.85',
                GPU_VRAM_CRITICAL_THRESHOLD: '0.95',
                GPU_VRAM_REJECT_THRESHOLD: '0.97',
                GPU_VRAM_RECOVER_THRESHOLD: '0.8',
                GPU_MONITOR_INTERVAL_MS: '15000'
            }
        },
        setInterval(fn, delay) {
            return { fn, delay, unref() { return this; } };
        }
    };

    vm.runInNewContext(source, context, { filename });

    return {
        gpuMonitor: module.exports,
        getMaxConcurrent: () => maxConcurrent,
        getUpdates: () => updates.slice(),
        getRejectingCalls: () => rejecting.slice()
    };
}

test('gpu monitor restores AI concurrency to runtime config after temporary downshift', async () => {
    const { gpuMonitor, getMaxConcurrent, getUpdates } = loadGpuMonitorHarness({
        configuredMax: 2,
        initialMax: 2,
        execOutputs: [
            '0, NVIDIA RTX, 900, 1000, 30, 55',
            '0, NVIDIA RTX, 500, 1000, 20, 45'
        ]
    });

    let state = await gpuMonitor.refreshGpuStatus();
    assert.equal(state.available, true);
    assert.equal(state.configuredMaxConcurrent, 2);
    assert.equal(state.maxConcurrentCap, 2);
    assert.equal(getMaxConcurrent(), 1);

    state = await gpuMonitor.refreshGpuStatus();
    assert.equal(state.available, true);
    assert.equal(state.maxConcurrentCap, 2);
    assert.equal(getMaxConcurrent(), 2);
    assert.deepEqual(getUpdates(), [1, 2]);
});

test('gpu monitor caps adaptive recovery at the saved global concurrency', async () => {
    const { gpuMonitor, getMaxConcurrent } = loadGpuMonitorHarness({
        configuredMax: 2,
        initialMax: 4,
        execOutputs: [
            '0, NVIDIA RTX, 300, 1000, 10, 40'
        ]
    });

    const state = await gpuMonitor.refreshGpuStatus();
    assert.equal(state.configuredMaxConcurrent, 2);
    assert.equal(state.maxConcurrentCap, 2);
    assert.equal(getMaxConcurrent(), 2);
});