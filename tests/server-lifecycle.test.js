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
        processRef
    });

    assert.equal(lifecycle.server, fakeServer);
    assert.deepEqual(calls.slice(0, 3), [['listen', 3210], ['info', { port: 3210, url: 'http://localhost:3210', version: 'test' }], ['maintenance']]);
    events.get('SIGTERM')();
    await Promise.resolve();
    assert.deepEqual(calls.slice(-2), [['close'], ['flush']]);
    assert.equal(processRef.exitCode, 0);
});
