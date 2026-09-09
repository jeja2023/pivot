const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDatabase, checkDatabaseAsync } = require('../server/services/system-health');

test('database health only observes an initialized pool', () => {
    const result = checkDatabase({ getPool: () => null });
    assert.deepEqual(result, {
        status: 'degraded',
        message: 'PostgreSQL 连接池未初始化'
    });
});

test('database health clears its timeout immediately after a successful probe', async () => {
    let scheduled = null;
    let cleared = null;
    const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
    const result = await checkDatabaseAsync(2000, {
        getPool: () => ({ query: async () => ({ rows: [{ ok: 1 }] }) }),
        setTimeoutFn(callback, delay) {
            scheduled = { callback, delay };
            return timer;
        },
        clearTimeoutFn(value) { cleared = value; }
    });

    assert.deepEqual(result, { status: 'ok', message: 'PostgreSQL 查询探针正常' });
    assert.equal(scheduled.delay, 2000);
    assert.equal(timer.unrefCalled, true);
    assert.equal(cleared, timer);
});

test('database health returns a bounded timeout failure', async () => {
    let timeoutCallback;
    const resultPromise = checkDatabaseAsync(50, {
        getPool: () => ({ query: () => new Promise(() => {}) }),
        setTimeoutFn(callback) {
            timeoutCallback = callback;
            return { unref() {} };
        },
        clearTimeoutFn() {}
    });
    timeoutCallback();
    const result = await resultPromise;
    assert.equal(result.status, 'error');
    assert.equal(result.message, '数据库健康探针超时');
});
