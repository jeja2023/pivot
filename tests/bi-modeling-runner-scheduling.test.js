'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const { clearImmediate } = require('node:timers');

function runnerFixture({ rejectReadiness = false } = {}) {
    const file = path.resolve(__dirname, '../server/services/data-analysis/bi/runner.js');
    const actualRequire = createRequire(file);
    const waiting = [], running = new Set(), released = [], gates = new Map();
    let readyCalls = 0, sequence = 0;
    const deps = {
        '../../../config/env-registry': { readTypedEnv: key => key === 'DATA_ANALYSIS_MODEL_ENABLED' ? true : 2 },
        '../../../repositories/analysis-model-jobs': {
            expired: async () => [], claim: async () => {
                if (running.size >= 2) return null;
                const job = waiting.shift(); if (job) running.add(job.id); return job || null;
            }, renew: async () => true, releaseSlot: async job => { running.delete(job.id); released.push(job.id); }, fail: async () => {}
        },
        '../../../repositories/analysis-objects': { release: async () => {} },
        '../../../repositories/analysis-operations': { workerHeartbeat: async () => {} },
        '../../../repositories/analysis-ingestions': { expireAbandoned: async () => {} },
        './readiness': { ensureReady: async () => { readyCalls++; if (rejectReadiness) throw Error('模拟就绪检查失败'); } },
        './ingestions': { executeIngestion: async job => gates.get(job.id).promise },
        'node:fs/promises': { mkdir: async () => {}, rm: async () => {} },
        '../shared': { tempRoot: path.join(__dirname, 'fixture-temp'), resolveInside: path.resolve,
            resolveAnalysisUser: async () => ({ id: 1, status: 'active' }) }
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: name => deps[name] || actualRequire(name), module,
        process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, AbortController, performance });
    return { runner: module.exports, readyCalls: () => readyCalls, released,
        add: () => {
            const id = `query_job_fixture-${++sequence}`;
            let resolve; const promise = new Promise(done => { resolve = done; });
            gates.set(id, { promise, resolve }); waiting.push({ id, user_id: 1, execution_epoch: 1, execution_kind: 'dataset_ingest' });
            return { id, finish: resolve };
        } };
}

test('后台认领和显式处理竞争时，显式调用等待实际任务及后续队列收敛', async () => {
    const fixture = runnerFixture();
    const first = fixture.add(), second = fixture.add(), third = fixture.add();
    let completed = false;
    const accepted = await fixture.runner.dispatchModelJobs();
    assert.equal(accepted.processed, 2); assert.equal(fixture.released.length, 0);
    await new Promise(resolve => setImmediate(resolve));
    const drain = fixture.runner.processModelJobs().then(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(completed, false);
    first.finish(); second.finish();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(completed, false);
    third.finish(); await drain;
    assert.deepEqual([...fixture.released].sort(), [first.id, second.id, third.id].sort());
    const manual = fixture.add();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.runner.activeModelExecutions().length, 0, '显式排空不能遗留后台唤醒认领下一批');
    const next = fixture.runner.processModelJobs(); manual.finish(); await next;
    await fixture.runner.stopModelJobs();
});

test('就绪检查失败不推进维保水位，下一次调度仍失败关闭', async () => {
    const fixture = runnerFixture({ rejectReadiness: true }); fixture.add();
    await assert.rejects(fixture.runner.processModelJobs(), /模拟就绪检查失败/);
    await assert.rejects(fixture.runner.processModelJobs(), /模拟就绪检查失败/);
    assert.equal(fixture.readyCalls(), 2); assert.equal(fixture.released.length, 0);
    await fixture.runner.stopModelJobs();
});
