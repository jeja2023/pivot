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

test('agent queue status is derived from persistent queued runs rather than stale in-memory hints', async () => {
    const { createAgentQueue } = require('../../server/services/agent-queue');
    const queue = createAgentQueue({
        logger: { info() {}, warn() {}, error() {} },
        instanceId: 'agent-status-test',
        maxConcurrent: 1,
        getRunUser: async () => null,
        runAgent: async () => {},
        markRunError: async () => {},
        getTimestamp: () => '2026-09-08 00:00:00',
        dbRunner: {
            async query(sql) {
                if (sql.includes('SELECT id\n            FROM agent_runs')) return [{ id: 'actual-queued-run' }];
                return [];
            },
            async queryOne(sql) {
                if (sql.includes('COUNT(*) AS count')) return { count: 1 };
                if (sql.includes('ORDER BY created_at ASC')) return { id: 'actual-queued-run', created_at: '2026-09-08 00:00:00' };
                return null;
            },
            async execute() { return 0; }
        }
    });
    queue.enqueueRun('stale-hint');
    const status = await queue.getStatusAsync();
    assert.equal(status.queued, 1);
    assert.equal(status.hinted, 1);
    assert.equal(status.oldestQueuedRunId, 'actual-queued-run');
    assert.ok(status.oldestQueuedAgeMs >= 0);
});
