const test = require('node:test');
const assert = require('node:assert/strict');
const { startHttpServer } = require('../server/server');

test('清理阶段卡住时总截止仍生效，重复信号不会重复退出', async () => {
    for (const stage of ['stopSpeechService', 'flushAllWrites', 'closePgPool']) {
        const calls = [], exits = [];
        const lifecycle = startHttpServer({ app: { listen: () => ({ close(callback) { callback(); }, closeAllConnections() { calls.push('close'); } }) },
            logger: { info() {}, warn(payload) { calls.push(payload); } }, processRef: { on() {}, exit(code) { exits.push(code); } },
            shutdownTimeoutMs: 25, getPendingWrites: () => ({ auditLogs: 1 }), [stage]: () => new Promise(() => {}) });
        lifecycle.gracefulShutdown('SIGTERM');
        lifecycle.gracefulShutdown('SIGINT');
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.deepEqual(exits, [1]);
        assert.ok(calls.some(call => call?.pendingWrites?.auditLogs === 1));
    }
});

test('HTTP lifecycle starts the app and flushes writes on shutdown', async () => {
    const events = new Map();
    const processRef = {
        on(name, handler) { events.set(name, handler); },
        exit(code) { this.exitCode = code; }
    };
    const calls = [];
    const logger = {
        info(payload) { calls.push(['info', payload]); },
        warn(payload) { calls.push(['warn', payload]); }
    };
    const fakeServer = {
        closeIdleConnections() { calls.push(['close-idle']); },
        closeAllConnections() { calls.push(['close-all']); },
        close(callback) { calls.push(['close']); callback(); }
    };
    const app = {
        listen(port, callback) { calls.push(['listen', port]); callback(); return fakeServer; }
    };

    const lifecycle = startHttpServer({
        app,
        port: 3210,
        logger,
        version: 'test',
        scheduleMaintenanceTasks() { calls.push(['maintenance']); },
        flushAllWrites() { calls.push(['flush']); },
        closeRealtimeClients(payload) { calls.push(['close-realtime', payload.reason]); },
        terminateSandboxProcesses() { calls.push(['terminate-sandboxes']); },
        terminateCapabilityWorkers() { calls.push(['terminate-workers']); },
        stopSpeechService() { calls.push(['stop-speech']); },
        processRef
    });

    assert.equal(lifecycle.server, fakeServer);
    assert.deepEqual(calls.slice(0, 3), [['listen', 3210], ['info', { port: 3210, url: 'http://localhost:3210', version: 'test' }], ['maintenance']]);
    events.get('SIGTERM')();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.slice(-7), [
        ['close-realtime', 'sigterm'],
        ['terminate-sandboxes'],
        ['terminate-workers'],
        ['close-idle'],
        ['close'],
        ['stop-speech'],
        ['flush']
    ]);
    assert.equal(processRef.exitCode, 0);
});

test('shutdown stops outbox work before closing the database pool', async () => {
    const handlers = new Map();
    const calls = [];
    let release;
    const stop = new Promise(resolve => { release = resolve; });
    const processRef = { on(name, handler) { handlers.set(name, handler); }, exit() { calls.push('exit'); } };
    startHttpServer({
        app: { listen: () => ({ close(callback) { callback(); } }) },
        logger: { info() {}, warn() {} }, processRef,
        stopBackgroundServices() { calls.push('stop'); return stop; },
        closePgPool() { calls.push('close-pool'); }
    });
    handlers.get('SIGTERM')();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['stop']);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['stop', 'close-pool', 'exit']);
});

test('维护停止失败不会阻断后台停止，也不会提前关闭数据库', async () => {
    const handlers = new Map();
    const calls = [];
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const schedule = () => {};
    schedule.cancel = () => { calls.push('maintenance'); throw new Error('模拟维护取消失败'); };
    const processRef = { on(name, handler) { handlers.set(name, handler); }, exit() { calls.push('exit'); } };
    startHttpServer({
        app: { listen: () => ({ close(callback) { callback(); } }) },
        logger: { info() {}, warn() { calls.push('warn'); } }, processRef,
        scheduleMaintenanceTasks: schedule,
        stopBackgroundServices() { calls.push('background'); return waiting; },
        closePgPool() { calls.push('close-pool'); }
    });
    handlers.get('SIGTERM')();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['maintenance', 'background', 'warn']);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['maintenance', 'background', 'warn', 'close-pool', 'exit']);
});
