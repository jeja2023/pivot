const test = require('node:test');
const assert = require('node:assert/strict');
const { startHttpServer } = require('../server/server');

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
        processRef
    });

    assert.equal(lifecycle.server, fakeServer);
    assert.deepEqual(calls.slice(0, 3), [['listen', 3210], ['info', { port: 3210, url: 'http://localhost:3210', version: 'test' }], ['maintenance']]);
    events.get('SIGTERM')();
    await Promise.resolve();
    assert.deepEqual(calls.slice(-6), [
        ['close-realtime', 'sigterm'],
        ['terminate-sandboxes'],
        ['terminate-workers'],
        ['close-idle'],
        ['close'],
        ['flush']
    ]);
    assert.equal(processRef.exitCode, 0);
});
