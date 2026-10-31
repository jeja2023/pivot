const test = require('node:test');
const assert = require('node:assert/strict');
const {
    registerProcessErrorHandlers,
    createMaintenanceScheduler,
    startBackgroundServices,
    startManagedRunner
} = require('../server/bootstrap');

test('process handlers log rejections and flush before fatal exit', async () => {
    const handlers = new Map();
    const calls = [];
    const processRef = {
        on(name, handler) { handlers.set(name, handler); },
        exit(code) { calls.push(['exit', code]); }
    };
    let scheduled;
    const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
    const logger = {
        fatal(payload, message) { calls.push(['fatal', payload.err, message]); },
        error(payload, message) { calls.push(['error', payload.err, message]); },
        warn(payload, message) { calls.push(['warn', payload.err, message]); }
    };

    registerProcessErrorHandlers({
        logger,
        flushAllWrites() { calls.push(['flush']); },
        processRef,
        setTimeoutFn(callback, delay) { scheduled = { callback, delay }; return timer; }
    });

    handlers.get('unhandledRejection')('rejected');
    assert.equal(calls[0][0], 'error');
    assert.equal(calls[0][1].message, 'rejected');

    const fatal = new Error('fatal');
    handlers.get('uncaughtException')(fatal);
    assert.deepEqual(calls.slice(1).map(call => call[0]), ['fatal', 'flush']);
    assert.equal(scheduled.delay, 5000);
    assert.equal(timer.unrefCalled, true);
    scheduled.callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.at(-1), ['exit', 1]);
});

test('maintenance scheduler supports immediate and delayed startup', () => {
    const calls = [];
    const logger = {
        info(payload) { calls.push(['info', payload]); },
        error(payload) { calls.push(['error', payload]); }
    };
    const immediate = createMaintenanceScheduler({
        delayMs: 0,
        logger,
        startMaintenanceTasks() { calls.push(['start']); }
    });
    immediate();
    assert.deepEqual(calls, [['start']]);

    let scheduled;
    const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
    const delayed = createMaintenanceScheduler({
        delayMs: 500,
        logger,
        startMaintenanceTasks() { calls.push(['delayed-start']); },
        setTimeoutFn(callback, delay) { scheduled = { callback, delay }; return timer; }
    });
    delayed();
    assert.equal(scheduled.delay, 500);
    assert.equal(timer.unrefCalled, true);
    scheduled.callback();
    assert.deepEqual(calls.at(-1), ['delayed-start']);
});

test('background services start monitors and defer recovery work', async () => {
    const calls = [];
    let deferred;
    const dependencies = {
        startGpuMonitor() { calls.push('gpu'); return Promise.resolve(); },
        startModelEndpointMonitor() { calls.push('model'); return Promise.resolve(); },
        recoverStaleKnowledgeDocumentIndexes() { calls.push('rag-recovery'); },
        recoverAgentRuns() { calls.push('agent-recovery'); },
        startAgentScheduleRunner() { calls.push('schedule-runner'); }
    };
    const logger = { warn() {} };

    startBackgroundServices({
        logger,
        dependencies,
        setImmediateFn(callback) { deferred = callback; }
    });
    await Promise.resolve();
    assert.deepEqual(calls, ['gpu', 'model']);
    deferred();
    await Promise.resolve();
    assert.deepEqual(calls, ['gpu', 'model', 'rag-recovery', 'agent-recovery', 'schedule-runner']);
});

test('shutdown cancellation prevents delayed maintenance from starting', () => {
    let callback;
    let cleared = false;
    let starts = 0;
    const timer = { unref() {} };
    const schedule = createMaintenanceScheduler({
        delayMs: 500, logger: { info() {}, error() {} },
        startMaintenanceTasks() { starts += 1; },
        setTimeoutFn(fn) { callback = fn; return timer; },
        clearTimeoutFn(value) { assert.equal(value, timer); cleared = true; }
    });
    schedule();
    schedule.cancel();
    callback();
    schedule();
    assert.equal(cleared, true);
    assert.equal(starts, 0);
});

test('取消已启动的维护任务会转交其停止操作', async () => {
    let stopped = false;
    const schedule = createMaintenanceScheduler({
        delayMs: 0, logger: { info() {}, error() {} },
        startMaintenanceTasks() { return async () => { stopped = true; }; }
    });
    schedule();
    await schedule.cancel();
    assert.equal(stopped, true);
});

test('background recovery catches rejected promises without leaking an unhandled rejection', async () => {
    let deferred;
    const warnings = [];
    startBackgroundServices({
        logger: { warn(payload, message) { warnings.push([message, payload.err]); } },
        dependencies: {
            startGpuMonitor() { return Promise.resolve(); },
            startModelEndpointMonitor() { return Promise.resolve(); },
            recoverStaleKnowledgeDocumentIndexes() { return Promise.reject(new Error('知识库数据库暂不可用')); },
            recoverAgentRuns() { return Promise.reject(new Error('智能体数据库暂不可用')); },
            startAgentScheduleRunner() {}
        },
        setImmediateFn(callback) { deferred = callback; }
    });

    deferred();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(warnings.map(([message]) => message), ['知识库索引恢复执行失败', '智能体任务恢复执行失败']);
    assert.deepEqual(warnings.map(([, error]) => error), ['知识库数据库暂不可用', '智能体数据库暂不可用']);
});

test('outbox does not start after shutdown races with deferred startup', async () => {
    let deferred;
    const calls = [];
    const stop = startBackgroundServices({
        logger: { warn() {} },
        setImmediateFn(callback) { deferred = callback; },
        agentEventDispatcher: { async stop() { calls.push('stop'); } },
        dependencies: {
            startAgentEventOutboxDispatcher() { calls.push('outbox'); },
            startAgentScheduleRunner() { calls.push('schedule'); }
        }
    });
    deferred();
    await stop();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['stop']);
});

test('分析执行器在启动与关机竞态时仍会停止', async () => {
    let deferred;
    let release;
    let started;
    const starting = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const calls = [];
    const stop = startBackgroundServices({
        logger: { warn() {} }, setImmediateFn(callback) { deferred = callback; },
        agentEventDispatcher: { async stop() { calls.push('outbox'); } },
        dependencies: { async startAnalysisRefreshRunner() {
            started();
            await pending;
            return { async stop() { calls.push('analysis'); } };
        } }
    });
    deferred();
    await starting;
    const stopping = stop();
    release();
    await stopping;
    assert.deepEqual(calls, ['analysis', 'outbox']);
});

test('受管执行器启动失败时清理已创建资源', async () => {
    let stopped = false;
    await assert.rejects(startManagedRunner(() => ({
        async start() { throw new Error('模拟启动失败'); },
        async stop() { stopped = true; }
    })), /模拟启动失败/);
    assert.equal(stopped, true);
});

test('已启动的知识库与熔断巡检在关机时停止', async () => {
    let deferred;
    const stopped = [];
    const stop = startBackgroundServices({
        logger: { warn() {} }, setImmediateFn(callback) { deferred = callback; },
        agentEventDispatcher: { async stop() {} },
        dependencies: {
            startKnowledgeSourceLifecycleWorker: async () => ({ stop() { stopped.push('knowledge'); } }),
            startSkillReleaseBreakerRunner: async () => ({ stop() { stopped.push('breaker'); } })
        }
    });
    deferred();
    await new Promise(resolve => setImmediate(resolve));
    await stop();
    assert.deepEqual(stopped.sort(), ['breaker', 'knowledge']);
});

test('关闭时等待思维导图和交易分析队列的停止操作', async () => {
    const stopped = [];
    const stop = startBackgroundServices({
        logger: { warn() {} }, setImmediateFn() {},
        agentEventDispatcher: { async stop() {} },
        dependencies: {
            startMindmapExportRunner: () => ({ async stop() { stopped.push('mindmap'); } }),
            startTransactionRunner: () => ({ async stop() { stopped.push('transactions'); } })
        }
    });
    await new Promise(resolve => setImmediate(resolve));
    await stop();
    assert.deepEqual(stopped.sort(), ['mindmap', 'transactions']);
});

test('启动与关闭竞态也会清理已经由路由加载的旧流式服务', async () => {
    const calls = [];
    const stop = startBackgroundServices({
        logger: { warn() {} }, setImmediateFn() {},
        agentEventDispatcher: { async stop() {} },
        dependencies: {
            startLegacyStreamingRunner() { calls.push('start'); },
            stopLegacyStreamingRunner() { calls.push('stop'); }
        }
    });
    await stop();
    assert.deepEqual(calls, ['stop']);
});
