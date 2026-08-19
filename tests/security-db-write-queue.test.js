const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const vm = require('node:vm');

function loadQueueModule({ failTimes = 1, flushMs = 5 } = {}) {
    const filename = path.resolve(__dirname, '../server/services/db-write-queue.js');
    const source = fs.readFileSync(filename, 'utf8');
    const module = { exports: {} };
    const localRequire = Module.createRequire(filename);
    const scheduledDelays = [];
    const timers = [];
    const loggerWarnings = [];
    const pgQueries = [];
    let auditLogFailures = failTimes;

    const fakePool = {
        async query(sql, params) {
            pgQueries.push({ sql, params });
            if (sql.includes('INSERT INTO "audit_logs"') && auditLogFailures > 0) {
                auditLogFailures -= 1;
                throw new Error('temporary pg failure');
            }
            return { rowCount: 1, rows: [] };
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
            PIVOT_DB_WRITE_QUEUE_DISABLED: '',
            PIVOT_DB_WRITE_FLUSH_MS: String(flushMs),
            PIVOT_DB_WRITE_BATCH_SIZE: '1'
        },
        once() {}
    };

    const requireWithMock = (request) => {
        if (request === '../db/pg-connection') return { getPgPool: () => fakePool };
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

    return { queue: module.exports, scheduledDelays, timers, loggerWarnings, pgQueries };
}

async function settleAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

async function runNextTimer(timers) {
    const timer = timers.find(item => !item.executed && !item.cleared);
    if (!timer) return false;
    timer.executed = true;
    timer.fn();
    await settleAsyncWork();
    return true;
}

test('postgres write queue retries a failed batch without a new enqueue', async () => {
    const { queue, scheduledDelays, timers, loggerWarnings, pgQueries } = loadQueueModule({ failTimes: 1, flushMs: 5 });

    queue.enqueueAuditLog({
        userId: 1,
        action: 'login',
        details: '{}',
        ipAddress: '127.0.0.1',
        timestamp: '2026-06-26 10:00:00'
    });

    await runNextTimer(timers);
    assert.equal(queue.getQueueStatus().auditLogs, 1);
    assert.ok(scheduledDelays.length >= 2);
    assert.ok(scheduledDelays[1] > scheduledDelays[0]);
    assert.ok(loggerWarnings.length >= 1);

    await runNextTimer(timers);

    assert.equal(queue.getQueueStatus().auditLogs, 0);
    assert.equal(pgQueries.filter(item => item.sql.includes('INSERT INTO "audit_logs"')).length, 2);
});
