'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startAsyncQueryRunner } = require('../server/services/data-analysis/semantic-models');
const { startAnalysisRefreshRunner } = require('../server/services/data-analysis/governance');
const { createKnowledgeSourceSyncScheduler } = require('../server/services/knowledge-sources');
const { createKnowledgeEmbeddingRecoveryRunner } = require('../server/services/knowledge-embedding-recovery');
const { createKnowledgeSourceLifecycleWorker } = require('../server/services/knowledge-source-lifecycle');
const { createWorkspaceMemorySourceLifecycleWorker } = require('../server/services/workspace-memory-source-lifecycle');
const { createKnowledgeGraphMaintenanceRunner } = require('../server/services/knowledge-graph');
const { createKnowledgeWikiCompileWorker } = require('../server/services/knowledge-wiki');
const { createSkillReleaseBreakerRunner } = require('../server/services/agent-skill-breaker');
const { createWorkflowReleaseBreakerRunner } = require('../server/services/agent-workflow-breaker');
const { createDecisionArtifactBreakerRunner } = require('../server/services/decision-artifact-breaker');
const { createMemoryOutcomeMetricsRunner } = require('../server/services/long-term-memory/memory-outcome-metrics');

for (const [name, createRunner] of [['异步查询', startAsyncQueryRunner], ['数据刷新', startAnalysisRefreshRunner]]) {
    test(`${name}执行器停止时等待在途任务且不再调度`, async () => {
        let callback;
        let scheduled = 0;
        let cleared = false;
        let release;
        const pending = new Promise(resolve => { release = resolve; });
        const timer = { unref() {} };
        const runner = createRunner({
            setTimeoutFn(fn) { callback = fn; scheduled += 1; return timer; },
            clearTimeoutFn(value) { assert.equal(value, timer); cleared = true; },
            processJobs: () => pending
        });
        callback();
        await Promise.resolve();
        let stopped = false;
        const stopping = runner.stop().then(() => { stopped = true; });
        await Promise.resolve();
        assert.equal(cleared, true);
        assert.equal(stopped, false);
        release();
        await stopping;
        assert.equal(stopped, true);
        assert.equal(scheduled, 1);
        // 同一个进程可在停止完成后重新启动。
        const next = createRunner({ setTimeoutFn() { return timer; }, clearTimeoutFn() {} });
        assert.notEqual(next, runner);
        await next.stop();
    });
}

for (const [name, makeRunner] of [
    ['知识来源生命周期', block => createKnowledgeSourceLifecycleWorker({ deps: { transaction: block }, logger: { warn() {} } })],
    ['工作区记忆来源', block => createWorkspaceMemorySourceLifecycleWorker({ deps: { transaction: block }, logger: { warn() {} } })],
    ['知识图谱维护', block => createKnowledgeGraphMaintenanceRunner({ deps: { execute: block } })],
    ['知识 Wiki 编译', block => createKnowledgeWikiCompileWorker({ deps: {
        getKnowledgeWikiConfig: () => ({ enabled: true, workerEnabled: true }), transaction: block
    } })]
]) {
    test(`${name}停止会等待在途作业`, async () => {
        let release;
        let notify;
        const entered = new Promise(resolve => { notify = resolve; });
        const pending = new Promise(resolve => { release = resolve; });
        const runner = makeRunner(async () => { notify(); await pending; return null; });
        runner.start();
        await entered;
        let stopped = false;
        const stopping = runner.stop().then(() => { stopped = true; });
        await Promise.resolve();
        assert.equal(stopped, false);
        release();
        await stopping;
        assert.equal(stopped, true);
    });
}

for (const [name, makeRunner, method] of [
    ['技能熔断', block => createSkillReleaseBreakerRunner({ sweep: block }), 'tick'],
    ['工作流熔断', block => createWorkflowReleaseBreakerRunner({ read: block }), 'tick'],
    ['决策模型熔断', block => createDecisionArtifactBreakerRunner({ enabled: true, query: block }), 'tick'],
    ['记忆效用指标', block => createMemoryOutcomeMetricsRunner({ deps: { query: block }, logger: { warn() {} } }), 'runOnce']
]) {
    test(`${name}巡检停止会等待在途工作并合并并发调用`, async () => {
        let release;
        let notify;
        let calls = 0;
        const entered = new Promise(resolve => { notify = resolve; });
        const pending = new Promise(resolve => { release = resolve; });
        const runner = makeRunner(async () => { calls += 1; notify(); await pending; return []; });
        const first = runner[method]();
        const second = runner[method]();
        await entered;
        let stopped = false;
        const stopping = runner.stop().then(() => { stopped = true; });
        await Promise.resolve();
        assert.equal(stopped, false);
        assert.equal(calls, 1);
        release();
        await Promise.all([first, second, stopping]);
        assert.equal(stopped, true);
    });
}

for (const [name, createRunner, taskName] of [
    ['知识来源同步', createKnowledgeSourceSyncScheduler, 'sync'],
    ['知识向量恢复', createKnowledgeEmbeddingRecoveryRunner, 'recover']
]) {
    test(`${name}启动期间关闭会等待首次任务且不安装后续定时器`, async () => {
        let release;
        let started;
        let scheduled = 0;
        const running = new Promise(resolve => { started = resolve; });
        const pending = new Promise(resolve => { release = resolve; });
        const runner = createRunner({
            [taskName]: async () => { started(); await pending; return {}; },
            logger: { info() {}, warn() {} },
            setIntervalFn() { scheduled += 1; return { unref() {} }; }, clearIntervalFn() {}
        });
        const start = runner.start();
        await running;
        let stopped = false;
        const stop = runner.stop().then(() => { stopped = true; });
        await Promise.resolve();
        assert.equal(stopped, false);
        release();
        await Promise.all([start, stop]);
        assert.equal(stopped, true);
        assert.equal(scheduled, 0);
    });
}
