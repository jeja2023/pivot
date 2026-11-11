const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const vm = require('node:vm');

function loadQueueModule({ failTimes = 1, failureMessage = 'temporary pg failure', flushMs = 5, queueMax = '', batchSize = 1, singleFailureAt = 0, onQuery = null, connectMode = false, hangWrites = false, queryTimeoutMs = 15000 } = {}) {
    const filename = path.resolve(__dirname, '../server/services/db-write-queue.js');
    const source = fs.readFileSync(filename, 'utf8');
    const module = { exports: {} };
    const localRequire = Module.createRequire(filename);
    const scheduledDelays = [];
    const timers = [];
    const loggerWarnings = [];
    const pgQueries = [];
    let auditLogFailures = failTimes;
    let auditSingleAttempts = 0;
    const clientState = { releases: [], destroyed: 0 };

    const fakePool = {
        async query(sql, params) {
            pgQueries.push({ sql, params });
            await onQuery?.({ sql, params });
            if (hangWrites && sql.includes('INSERT INTO')) return new Promise(() => {});
            if (sql.includes('INSERT INTO "audit_logs"') && auditLogFailures > 0) {
                auditLogFailures -= 1;
                throw new Error(failureMessage);
            }
            if (sql.includes('INSERT INTO "audit_logs"') && params.length === 5) {
                auditSingleAttempts += 1;
                if (singleFailureAt > 0 && auditSingleAttempts === singleFailureAt) {
                    throw new Error('temporary single-row pg failure');
                }
            }
            return { rowCount: 1, rows: [] };
        }
    };
    if (connectMode) {
        fakePool.connect = async () => ({
            connection: { stream: { destroy() { clientState.destroyed += 1; } } },
            query: fakePool.query,
            release(error) { clientState.releases.push(error || null); }
        });
    }

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
            PIVOT_DB_WRITE_BATCH_SIZE: String(batchSize),
            PIVOT_DB_AUDIT_QUEUE_MAX: queueMax ? String(queueMax) : '',
            PIVOT_DB_WRITE_QUERY_TIMEOUT_MS: String(queryTimeoutMs)
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

    return { queue: module.exports, scheduledDelays, timers, loggerWarnings, pgQueries, clientState };
}

async function settleAsyncWork() {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

test('用量批次移出队列后，额度快照等待该批确认，不出现零用量空窗', async () => {
    let entered, finish;
    const started = new Promise(resolve => { entered = resolve; });
    let committed = 0, reads = 0;
    const fixture = loadQueueModule({ failTimes: 0, onQuery: async ({ sql }) => {
        if (sql.includes('model_usage_events')) { entered(); await new Promise(resolve => { finish = resolve; }); committed = 7; }
    } });
    fixture.queue.enqueueModelUsageEvent({ userId: 1, modelId: 2, tokenCount: 7, createdAt: '2026-11-10 12:00:00' });
    const flush = fixture.queue.flushWriteQueue(); await started;
    const snapshot = fixture.queue.readModelUsageSnapshot(async () => { reads++; return committed + fixture.queue.getPendingModelUsageTotal(1, 2); });
    await settleAsyncWork(); assert.equal(reads, 0);
    finish(); await flush;
    assert.equal(await snapshot, 7); assert.equal(reads, 1);
});

test('用量查询期间发生入队或批次刷新，必须重新取得一致快照且不重复统计', async () => {
    let committed = 0;
    const fixture = loadQueueModule({ failTimes: 0, onQuery: async ({ sql }) => { if (sql.includes('model_usage_events')) committed = 9; } });
    fixture.queue.enqueueModelUsageEvent({ userId: 1, modelId: 2, tokenCount: 9 });
    let resume, entered, reads = 0;
    const started = new Promise(resolve => { entered = resolve; });
    const snapshot = fixture.queue.readModelUsageSnapshot(async () => {
        if (++reads === 1) { entered(); await new Promise(resolve => { resume = resolve; }); return 0; }
        return committed + fixture.queue.getPendingModelUsageTotal(1, 2);
    });
    await started; await fixture.queue.flushWriteQueue(); resume();
    assert.equal(await snapshot, 9); assert.equal(reads, 2);
});

test('用量快照不等待其他审计日志写入', async () => {
    let finish, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const fixture = loadQueueModule({ failTimes: 0, onQuery: async ({ sql }) => {
        if (sql.includes('audit_logs')) { entered(); await new Promise(resolve => { finish = resolve; }); }
    } });
    fixture.queue.enqueueAuditLog({ action: '合成审计' });
    const flush = fixture.queue.flushWriteQueue(); await started;
    assert.equal(await fixture.queue.readModelUsageSnapshot(async () => 3), 3);
    finish(); await flush;
});

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

test('postgres write queue enters fast flush mode at the high-water mark', async () => {
    const { queue, scheduledDelays, loggerWarnings } = loadQueueModule({ failTimes: 0, flushMs: 250, queueMax: 5 });
    for (let index = 0; index < 4; index += 1) {
        queue.enqueueAuditLog({ userId: 1, action: `audit-${index}`, details: '{}', timestamp: '2026-06-26 10:00:00' });
    }
    assert.ok(scheduledDelays.includes(50));
    assert.ok(loggerWarnings.some(args => String(args[1] || '').includes('高水位')));
});

test('one flush cycle does not chase records continuously added by producers', async () => {
    let queue;
    let injected = false;
    const loaded = loadQueueModule({ failTimes: 0, flushMs: 5, onQuery: ({ sql }) => {
        if (!injected && sql.includes('INSERT INTO "audit_logs"')) {
            injected = true;
            queue.enqueueAuditLog({ userId: 1, action: 'arrived-during-flush', details: '{}', timestamp: '2026-06-26 10:00:00' });
        }
    } });
    queue = loaded.queue;
    queue.enqueueAuditLog({ userId: 1, action: 'initial', details: '{}', timestamp: '2026-06-26 10:00:00' });

    await queue.flushWriteQueue();
    assert.equal(queue.getQueueStatus().auditLogs, 1);
    await queue.flushWriteQueue();
    assert.equal(queue.getQueueStatus().auditLogs, 0);
});

test('batch fallback requeues the failed row and all unattempted tail rows', async () => {
    const { queue } = loadQueueModule({ failTimes: 1, failureMessage: 'violates check constraint', flushMs: 5, batchSize: 3, singleFailureAt: 2 });
    for (let index = 0; index < 3; index += 1) {
        queue.enqueueAuditLog({ userId: 1, action: `audit-${index}`, details: '{}', timestamp: '2026-06-26 10:00:00' });
    }

    await queue.flushWriteQueue();
    assert.equal(queue.getQueueStatus().auditLogs, 2);

    await queue.flushWriteQueue();
    assert.equal(queue.getQueueStatus().auditLogs, 0);
});

test('hung PostgreSQL write times out and removes the stuck client', async () => {
    const loaded = loadQueueModule({ failTimes: 0, flushMs: 5, connectMode: true, hangWrites: true, queryTimeoutMs: 20 });
    loaded.queue.enqueueAuditLog({ userId: 1, action: 'timeout', details: '{}', timestamp: '2026-06-26 10:00:00' });

    await runNextTimer(loaded.timers);
    await runNextTimer(loaded.timers);
    await settleAsyncWork();

    assert.equal(loaded.queue.getQueueStatus().auditLogs, 1);
    assert.equal(loaded.clientState.destroyed, 1);
    assert.equal(loaded.clientState.releases.length, 1);
    assert.equal(loaded.clientState.releases[0]?.code, 'PG_WRITE_QUEUE_QUERY_TIMEOUT');
});

test('enqueueAuditLog normalizes ip and defaults missing timestamp', async () => {
    const queries = [];
    const { queue } = loadQueueModule({ failTimes: 0, flushMs: 5, onQuery: (q) => queries.push(q) });
    queue.enqueueAuditLog({ userId: 1, action: '向量模型连接测试', details: '{}', ip: '192.168.1.123' });
    await queue.flushWriteQueue();

    const insert = queries.find(q => q.sql.includes('INSERT INTO "audit_logs"'));
    assert.ok(insert);
    assert.equal(insert.params[3], '192.168.1.123');
    assert.match(insert.params[4], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});
