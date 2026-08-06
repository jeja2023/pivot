const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadAgentQueueModule(setImmediateMock) {
    const filename = path.resolve(__dirname, '../../server/services/agent-queue.js');
    const source = fs.readFileSync(filename, 'utf8');
    const module = { exports: {} };

    vm.runInNewContext(source, {
        module,
        exports: module.exports,
        require: createRequire(filename),
        console,
        process,
        Buffer,
        setImmediate: setImmediateMock,
        clearImmediate: () => {}
    }, { filename });

    return module.exports;
}

test('agent queue coalesces repeated wakeups into one scheduled drain', () => {
    const scheduled = [];
    const { createAgentQueue } = loadAgentQueueModule((fn) => {
        scheduled.push(fn);
        return scheduled.length;
    });

    const db = {
        prepare() {
            return {
                all() { return []; },
                run() { return { changes: 0 }; },
                get() { return { count: 0 }; }
            };
        }
    };

    const queue = createAgentQueue({
        db,
        logger: { info() {}, warn() {}, error() {} },
        instanceId: 'agent-test',
        maxConcurrent: 1,
        getRunUser: () => ({ id: 1, username: 'tester' }),
        runAgent: async () => {},
        markRunError: () => {},
        getTimestamp: () => '2026-06-26 00:00:00'
    });

    queue.enqueueRun('run-1');
    queue.enqueueRun('run-2');
    queue.updateMaxConcurrent(2);
    queue.recoverQueued(10);

    assert.equal(scheduled.length, 1);
    scheduled[0]();
    assert.equal(scheduled.length, 1);
});
