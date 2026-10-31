'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createQueueRunner } = require('../server/services/queue-runner');

test('后台队列关闭等待在途工作，取消未执行调度，并允许重新启动', async () => {
    let release;
    let markStarted;
    const ready = new Promise(resolve => { markStarted = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const runner = createQueueRunner(async ({ shouldStop }) => {
        calls += 1;
        if (calls === 1) { markStarted(); await gate; assert.equal(shouldStop(), true); }
    }, 60000);
    runner.start();
    await ready;
    runner.schedule();
    let stopped = false;
    const stop = runner.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    assert.equal(calls, 1);
    release();
    await stop;
    runner.schedule();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    runner.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    await runner.stop();
});
