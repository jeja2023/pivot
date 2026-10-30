'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMaintenanceTaskController } = require('../server/services/maintenance-task-controller');

test('维护任务关闭时清理定时器并等待已开始的任务', async () => {
    let callback;
    let cancelled = false;
    let release;
    let started = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const timer = { unref() {} };
    const controller = createMaintenanceTaskController({
        setIntervalFn(fn) { callback = fn; return timer; },
        clearIntervalFn(value) { assert.equal(value, timer); cancelled = true; }
    });
    controller.every(100, async () => { started += 1; await pending; });
    callback();
    await Promise.resolve();
    callback();
    await Promise.resolve();
    assert.equal(started, 1, '同一周期任务仍在运行时不重复启动');
    let stopped = false;
    const stopping = controller.stop().then(() => { stopped = true; });
    callback();
    await Promise.resolve();
    assert.equal(cancelled, true);
    assert.equal(started, 1);
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.equal(stopped, true);
});

test('尚未启动的维护任务不会在关机后启动', async () => {
    let started = false;
    const controller = createMaintenanceTaskController();
    controller.run(() => { started = true; });
    await controller.stop();
    assert.equal(started, false);
});

test('启动时的首次执行与定期执行不会重叠', async () => {
    let callback;
    let release;
    let count = 0;
    const waiting = new Promise(resolve => { release = resolve; });
    const controller = createMaintenanceTaskController({
        setIntervalFn(fn) { callback = fn; return { unref() {} }; },
        clearIntervalFn() {}
    });
    controller.every(100, async () => { count += 1; await waiting; }, undefined, { immediate: true });
    await Promise.resolve();
    callback();
    await Promise.resolve();
    assert.equal(count, 1);
    release();
    await controller.stop();
});
