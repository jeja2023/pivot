'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPeriodicRunner } = require('../server/services/periodic-runner');

test('周期任务关闭会取消初始延迟和定时器，并等待在途工作', async () => {
    let initial;
    let interval;
    let release;
    let calls = 0;
    const cleared = [];
    const pending = new Promise(resolve => { release = resolve; });
    const runner = createPeriodicRunner({
        intervalMs: 100, initialDelayMs: 50,
        run: async () => { calls += 1; await pending; },
        setTimeoutFn(fn) { initial = fn; return { id: 'initial', unref() {} }; },
        setIntervalFn(fn) { interval = fn; return { id: 'interval', unref() {} }; },
        clearTimeoutFn(timer) { cleared.push(timer.id); }, clearIntervalFn(timer) { cleared.push(timer.id); }
    });
    runner.start();
    interval();
    await Promise.resolve();
    initial();
    await Promise.resolve();
    assert.equal(calls, 1);
    let stopped = false;
    const stopping = runner.stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    assert.deepEqual(cleared, ['interval']);
    release();
    await stopping;
    interval();
    assert.equal(calls, 1);
});

test('尚未触发的初始周期任务在关机后不会执行', async () => {
    let initial;
    const cleared = [];
    let calls = 0;
    const runner = createPeriodicRunner({
        intervalMs: 100, initialDelayMs: 50, run: () => { calls += 1; },
        setTimeoutFn(fn) { initial = fn; return { id: 'initial', unref() {} }; },
        setIntervalFn() { return { id: 'interval', unref() {} }; },
        clearTimeoutFn(timer) { cleared.push(timer.id); }, clearIntervalFn(timer) { cleared.push(timer.id); }
    });
    runner.start();
    await runner.stop();
    initial();
    await Promise.resolve();
    assert.equal(calls, 0);
    assert.deepEqual(cleared, ['initial', 'interval']);
});
