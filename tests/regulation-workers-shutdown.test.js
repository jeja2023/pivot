'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRegulationImportWorker } = require('../server/services/regulations/import-jobs');
const { createRegulationIndexRecoveryRunner } = require('../server/services/regulations/mutations');

test('法规导入停机等待已领取任务完成并阻止重新启动', async () => {
    let releaseClaim;
    let notifyClaim;
    let releaseJob;
    let notifyJob;
    const claiming = new Promise(resolve => { notifyClaim = resolve; });
    const claimGate = new Promise(resolve => { releaseClaim = resolve; });
    const working = new Promise(resolve => { notifyJob = resolve; });
    const jobGate = new Promise(resolve => { releaseJob = resolve; });
    let claims = 0;
    let complete = false;
    const worker = createRegulationImportWorker({
        recoverJobs: async () => {},
        claimJob: async () => { claims += 1; notifyClaim(); await claimGate; return { id: 1 }; },
        processJob: async () => { notifyJob(); await jobGate; complete = true; },
        failJob: async () => ({}), logger: { warn() {} }
    });
    const starting = worker.start();
    await claiming;
    let stopped = false;
    const stopping = worker.shutdown().then(() => { stopped = true; });
    releaseClaim();
    await working;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    releaseJob();
    await Promise.all([starting, stopping]);
    assert.equal(complete, true);
    assert.equal((await worker.start()).started, false);
    assert.equal(claims, 1);
});

test('法规向量恢复停机等待执行中的巡检且拒绝后续触发', async () => {
    let release;
    let notify;
    const ready = new Promise(resolve => { notify = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const runner = createRegulationIndexRecoveryRunner({
        recover: async () => { calls += 1; notify(); await gate; return {}; },
        logger: { warn() {} }
    });
    await runner.start();
    await ready;
    let stopped = false;
    const stopping = runner.shutdown().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.equal((await runner.tick()).skipped, true);
    assert.equal((await runner.start()).started, false);
    assert.equal(calls, 1);
});

test('法规导入启动恢复期间停机不会留下轮询', async () => {
    let release;
    let notify;
    let timers = 0;
    const ready = new Promise(resolve => { notify = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const worker = createRegulationImportWorker({
        recoverJobs: async () => { notify(); await gate; },
        claimJob: async () => { throw new Error('停机后不能领取'); },
        setIntervalFn() { timers += 1; }
    });
    const starting = worker.start();
    await ready;
    const stopping = worker.shutdown();
    release();
    await Promise.all([starting, stopping]);
    assert.equal(timers, 0);
    assert.equal(worker.getRuntimeStatus().started, false);
});
