'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMaintenanceTaskController } = require('../server/services/maintenance-task-controller');

test('重型维护串行执行、失败继续，停止后不启动剩余步骤', async () => {
    const controller=createMaintenanceTaskController(),events=[];
    let release;
    const first=new Promise(resolve=>{release=resolve;});
    const running=controller.series([
        async()=>{events.push('第一步');await first;throw new Error('模拟失败');},
        async()=>{events.push('第二步');}
    ],()=>events.push('已记录失败'));
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(events,['第一步']);release();await running;
    assert.deepEqual(events,['第一步','已记录失败','第二步']);
    let finish;
    const pending=controller.series([()=>new Promise(resolve=>{finish=resolve;}),()=>events.push('不应运行')]);
    await new Promise(resolve=>setImmediate(resolve));
    const stopped=controller.stop();finish();await stopped;await pending;
    assert.equal(events.includes('不应运行'),false);
});

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
