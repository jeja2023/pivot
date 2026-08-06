const test = require('node:test');
const assert = require('node:assert/strict');
const {
    registerProcessErrorHandlers,
    createMaintenanceScheduler,
    startBackgroundServices
} = require('../server/bootstrap');

test('process handlers log rejections and flush before fatal exit', () => {
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
        flushAllSqliteWrites() { calls.push(['flush']); },
        processRef,
        setTimeoutFn(callback, delay) { scheduled = { callback, delay }; return timer; }
    });

    handlers.get('unhandledRejection')('rejected');
    assert.equal(calls[0][0], 'error');
    assert.equal(calls[0][1].message, 'rejected');

    const fatal = new Error('fatal');
    handlers.get('uncaughtException')(fatal);
    assert.deepEqual(calls.slice(1).map(call => call[0]), ['fatal', 'flush']);
    assert.equal(scheduled.delay, 250);
    assert.equal(timer.unrefCalled, true);
    scheduled.callback();
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
    assert.deepEqual(calls, ['gpu', 'model', 'rag-recovery', 'agent-recovery', 'schedule-runner']);
});
