const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const vm = require('node:vm');

function loadQueueModule({ failTimes = 1, flushMs = 5 } = {}) {
    const filename = path.resolve(__dirname, '../server/services/sqlite-write-queue.js');
    const source = fs.readFileSync(filename, 'utf8');
    const module = { exports: {} };
    const localRequire = Module.createRequire(filename);
    const scheduledDelays = [];
    const timers = [];
    const loggerWarnings = [];
    let auditLogFailures = failTimes;

    const fakeDb = {
        prepare(sql) {
            const isAuditLogInsert = sql.includes('INSERT INTO audit_logs');
            return {
                run() {
                    if (isAuditLogInsert && auditLogFailures > 0) {
                        auditLogFailures -= 1;
                        throw new Error('database is locked');
                    }
                    return { changes: 1 };
                }
            };
        },
        transaction(fn) {
            return (items) => fn(items);
        }
    };

    function fakeSetTimeout(fn, delay) {
        const timer = {
            fn,
            delay,
            cleared: false,
            executed: false,
            unref() {
                return this;
            }
        };
        timers.push(timer);
        scheduledDelays.push(delay);
        return timer;
    }

    function fakeClearTimeout(timer) {
        if (timer) timer.cleared = true;
    }

    const sandboxProcess = {
        env: {
            ...process.env,
            PIVOT_SQLITE_WRITE_QUEUE_SYNC: '',
            PIVOT_SQLITE_WRITE_FLUSH_MS: String(flushMs),
            PIVOT_SQLITE_WRITE_BATCH_SIZE: '1'
        },
        once() {}
    };

    const requireWithMock = (request) => {
        if (request === '../db') return { db: fakeDb };
        if (request === '../logger') return { logger: { warn: (...args) => loggerWarnings.push(args) } };
        return localRequire(request);
    };

    vm.runInNewContext(source, {
        require: requireWithMock,
        module,
        exports: module.exports,
        __dirname: path.dirname(filename),
        __filename: filename,
        console,
        process: sandboxProcess,
        Buffer,
        setTimeout: fakeSetTimeout,
        clearTimeout: fakeClearTimeout,
        setInterval: () => {},
        clearInterval: () => {}
    }, { filename });

    return { queue: module.exports, scheduledDelays, timers, loggerWarnings };
}

function drainTimers(timers, limit = 20) {
    for (let i = 0; i < limit; i += 1) {
        const timer = timers.find(item => !item.executed && !item.cleared);
        if (!timer) return;
        timer.executed = true;
        timer.fn();
    }
    throw new Error('timer drain limit exceeded');
}

test('sqlite write queue retries a failed batch without a new enqueue', () => {
    const { queue, scheduledDelays, timers, loggerWarnings } = loadQueueModule({ failTimes: 1, flushMs: 5 });

    queue.enqueueAuditLog({
        userId: 1,
        action: 'login',
        details: '{}',
        ipAddress: '127.0.0.1',
        timestamp: '2026-06-26 10:00:00'
    });

    drainTimers(timers);

    assert.equal(queue.getQueueStatus().auditLogs, 0);
    assert.ok(scheduledDelays.length >= 2);
    assert.ok(scheduledDelays[1] > scheduledDelays[0]);
    assert.ok(loggerWarnings.length >= 1);
});