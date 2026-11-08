'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TaskBudget } = require('../server/services/agent-budget');
const { profileRoundPolicy } = require('../server/services/agent-round-policy');
const { resolveChatAgentBudget } = require('../server/services/agent-token-policy');
const { prepareExecutionBudget } = require('../server/services/agent-runtime/execution-budget');
const { continueRunFromCheckpoint } = require('../server/services/agent-runtime/run-continuation');
const { buildRunProgress } = require('../server/services/agent-round-progress');

test('新任务按明确结构分档，开启工具或单个文件不会误升级复杂档', () => {
    const standard = resolveChatAgentBudget({ mcpEnabled: true, decision: { action: 'agent_run', deliverables: ['报告'], requiredCapabilities: ['data.read', 'document.render'] } });
    assert.equal(standard.segmentMaxSteps, 30); assert.equal(standard.budget.max_steps, 60);
    const complex = resolveChatAgentBudget({ decision: { action: 'agent_run', deliverables: ['图形', '报告'], requiredCapabilities: ['knowledge.search', 'document.render'] } });
    assert.equal(complex.profile, 'complex'); assert.equal(complex.segmentMaxSteps, 50); assert.equal(complex.budget.max_steps, 120); assert.equal(complex.runMode, 'deep');
    const knowledge = resolveChatAgentBudget({ ragEnabled: true, content: '制度是什么？' });
    assert.equal(knowledge.segmentMaxSteps, 6); assert.equal(knowledge.budget.max_steps, 6);
});

test('累计轮次与所有资源计数在恢复后延续，显式小预算和零预算不扩大', async () => {
    const run = { id: 'budget', max_steps: 3, budget_config: { max_steps: 5, max_tokens_total: 10000 }, total_tokens: 80 };
    const snapshots = [];
    const deps = { listSteps: async () => [], updateRun: async (_id, patch) => snapshots.push(JSON.parse(patch.usage_stats)) };
    const first = (await prepareExecutionBudget(run, deps)).taskBudget;
    await first.beginPlanningRound(); first.consumeTool({ name: 'example.read', risk_level: 2, network: true });
    first.recordProgress('example.read', {}, { rows: [1] }); first.recordTokens(20); await first.persistUsageSnapshot();
    const resumed = (await prepareExecutionBudget(run, deps)).taskBudget;
    assert.equal(resumed.counts.steps, 1); assert.equal(resumed.counts.tool_calls, 1);
    assert.equal(resumed.counts.risk, 2); assert.equal(resumed.counts.network_requests, 1);
    assert.equal(resumed.counts.tokens_total, 100); assert.equal(resumed.progress.count, 1);
    assert.equal(resumed.limits.max_steps, 5); assert.equal(resumed.segmentStartSteps, 0);
    assert.equal(resumed.remainingSegmentRounds(), 2);
    assert.equal(snapshots.at(-1).accountingVersion, 2);
    const zero = (await prepareExecutionBudget({ ...run, budget_config: { max_steps: 0 }, usage_stats: '{}' }, deps)).taskBudget;
    await assert.rejects(zero.beginPlanningRound(), error => error.code === 'AGENT_BUDGET_EXCEEDED');
});

test('流式与回退规划共享本段额度，预留工具与模型额度不重置累计上限', async () => {
    const policy = { ...profileRoundPolicy('standard', 10000), segmentSteps: 3 };
    const budget = new TaskBudget({ max_steps: 5, max_tokens_total: 10000 }, { policy });
    await budget.beginPlanningRound(); await budget.beginPlanningRound();
    assert.equal(budget.remainingSegmentRounds(), 1);
    await budget.beginPlanningRound(); assert.equal(budget.remainingSegmentRounds(), 0);
    const resumed = new TaskBudget(budget.limits, { policy, counts: budget.counts, progress: budget.progress });
    await resumed.beginPlanningRound(); await resumed.beginPlanningRound();
    await assert.rejects(resumed.beginPlanningRound(), error => error.code === 'AGENT_BUDGET_EXCEEDED');
    assert.equal(resumed.counts.steps, 5);
});

test('发现和重复结果不当作新进展，时间戳变化与重排对象键不能绕过', async () => {
    const budget = new TaskBudget({ max_steps: 60 }, { policy: { ...profileRoundPolicy('standard', 10000), noProgressRounds: 3 } });
    assert.equal(budget.recordProgress('tools.search', {}, { candidates: ['x'] }), false);
    assert.equal(budget.recordProgress('tools.describe', {}, { schema: {} }), false);
    assert.equal(budget.recordProgress('tools.execute', {}, { executed: false, toolRef: { name: 'example.read' }, inputSchema: {} }), false);
    await budget.beginPlanningRound();
    assert.equal(budget.recordProgress('rag.search', {}, { retrieval: { status: 'blocked' }, matches: [] }), false);
    assert.equal(budget.recordProgress('example.query', {}, { rows: [1], timestamp: 'a' }), true);
    assert.equal(budget.recordProgress('example.query', { query: 'changed' }, { timestamp: 'b', rows: [1] }), false);
    for (let index = 0; index < 3; index++) await budget.beginPlanningRound();
    await assert.rejects(budget.beginPlanningRound(), error => error.code === 'AGENT_NO_PROGRESS');
});

test('预算写入失败时在模型或外部工具执行前停止', async () => {
    const budget = new TaskBudget({ max_steps: 60 }, { persist: async () => { throw new Error('数据库不可用'); } });
    await assert.rejects(budget.beginPlanningRound(), error => error.code === 'AGENT_BUDGET_PERSIST_FAILED');
    assert.equal(budget.counts.steps, 1);
});

test('升级默认容量后，旧任务用量快照中的风险限额和零额度仍保留', async () => {
    for (const risk of [0, 20]) {
        const run = { id: 'legacy-risk', max_steps: 30, budget_config: {}, usage_stats: { accountingVersion: 2, counts: {}, limits: { risk_budget: risk } } };
        const deps = { listSteps: async () => [], updateRun: async () => {} };
        assert.equal((await prepareExecutionBudget(run, deps)).taskBudget.limits.risk_budget, risk);
        run.budget_config = { risk_budget: 5 };
        assert.equal((await prepareExecutionBudget(run, deps)).taskBudget.limits.risk_budget, 5);
    }
});

test('收尾预算只供总结、文件登记和核验使用，仍受累计 Token 和工具总数约束', async () => {
    const policy = profileRoundPolicy('standard', 10000);
    const budget = new TaskBudget({ max_tokens_total: 10000, max_tool_calls: 8, max_runtime_seconds: 600 }, { policy });
    budget.recordTokens(9000);
    assert.throws(() => budget.assertCanRequestModel(), error => error.code === 'AGENT_FINALIZATION_REQUIRED');
    await budget.withFinalization(async () => {
        assert.equal(budget.modelOutputAllowance(200, 4096), 800);
        budget.recordTokens(800);
        assert.throws(() => budget.modelOutputAllowance(300, 500), error => error.code === 'AGENT_BUDGET_EXCEEDED');
    });
    const tools = new TaskBudget({ max_tool_calls: 8 }, { policy });
    for (let index = 0; index < 6; index++) tools.consumeTool({ name: 'example.read' });
    assert.throws(() => tools.consumeTool({ name: 'example.read' }), error => error.code === 'AGENT_FINALIZATION_REQUIRED');
    tools.consumeTool({ name: 'artifact.render' });
    await tools.withFinalization(async () => tools.consumeTool({ name: 'artifact.render' }));
    assert.throws(() => tools.consumeTool({ name: 'artifact.render' }), error => error.code === 'AGENT_BUDGET_EXCEEDED');
});

test('恢复时累计运行时间不会重新获得完整时间额度', async () => {
    const run = { id: 'time', max_steps: 30, budget_config: { max_runtime_seconds: 100 }, usage_stats: { accountingVersion: 2, elapsed_seconds: 90, counts: { steps: 3 } } };
    const value = await prepareExecutionBudget(run, { listSteps: async () => [], updateRun: async () => {} });
    assert.ok(value.deadline - Date.now() <= 10000);
    assert.ok(value.executionDeadline < value.deadline);
    assert.ok(value.taskBudget.elapsedSeconds() >= 90);
});

test('同一段审批和重启不重新分配轮次，用户修订可重新尝试但不清空累计', async () => {
    const run = { id: 'resume', max_steps: 3, metadata: { taskContract: { revision: 1 } }, budget_config: { max_steps: 6 } };
    const deps = { listSteps: async () => [], updateRun: async (_id, patch) => { run.usage_stats = patch.usage_stats; } };
    const first = (await prepareExecutionBudget(run, deps)).taskBudget;
    await first.beginPlanningRound(); await first.beginPlanningRound();
    const afterApproval = (await prepareExecutionBudget(run, deps)).taskBudget;
    assert.equal(afterApproval.remainingSegmentRounds(), 1);
    run.metadata.taskContract.revision = 2;
    const revised = (await prepareExecutionBudget(run, deps)).taskBudget;
    assert.equal(revised.counts.steps, 2);
    assert.equal(revised.progress.lastProgressRound, 2);
    assert.equal(revised.limits.max_steps, 6);
});

function continuationDeps() {
    const writes = [], metadata = [], queues = [];
    return { writes, metadata, queues, deps: {
        AGENT_AUTO_CONTINUE_ON_STEP_LIMIT: true, AGENT_AUTO_CONTINUE_ON_TIMEOUT: true,
        AGENT_MAX_AUTO_CONTINUATIONS: 12, AGENT_MAX_TOTAL_RUNTIME_MS: 7200000,
        TERMINAL_STATUSES: new Set(['completed', 'cancelled']), getRunMetadata: run => run.metadata || {},
        getRunStatus: async () => 'executing', queryOne: async () => null,
        buildAgentResumeContext: async () => ({ latestStepIndex: 7, observations: [] }), getBeijingTimestamp: () => new Date().toISOString(),
        setRunMetadata: async (_id, value) => metadata.push(value), updateRun: async (_id, value) => writes.push(value),
        listSteps: async () => [], insertStep: async () => {}, createAgentNotification: async () => {}, enqueueAgentRun: () => queues.push(1)
    } };
}

test('有真实新进展且累计有余额才自动续跑，工具未确认、总额耗尽和无进展均停止', async () => {
    const run = { id: 'continue', max_steps: 3, created_at: new Date().toISOString(), budget_config: { max_steps: 6 } };
    for (const scenario of ['progress', 'empty', 'pending', 'limit']) {
        const current = continuationDeps();
        const budget = new TaskBudget({ max_steps: 6 }, { policy: { ...profileRoundPolicy('standard', 10000), segmentSteps: 3 } });
        await budget.beginPlanningRound();
        if (scenario !== 'empty') budget.recordProgress('example.read', {}, { rows: [1] });
        if (scenario === 'pending') current.deps.queryOne = async () => ({ checkpoint_id: 'pending' });
        if (scenario === 'limit') budget.counts.steps = 6;
        const continued = await continueRunFromCheckpoint({ run, runId: run.id, user: { id: 7 }, taskBudget: budget, error: new Error('本段结束'), reason: 'step_limit' }, current.deps);
        assert.equal(continued, scenario === 'progress');
        assert.equal(current.queues.length, scenario === 'progress' ? 1 : 0);
    }
});

test('界面轮次区分本段与累计，不把多条工具日志当规划轮次', () => {
    const progress = buildRunProgress({ status: 'running', run_mode: 'standard', max_steps: 30, budget_config: { max_steps: 60 },
        usage_stats: { counts: { steps: 35, tool_calls: 50 }, segment: { startSteps: 30 } }, metadata: { autoContinuation: { count: 1 } } },
    [{ type: 'tool' }, { type: 'tool' }, { type: 'control' }]);
    assert.equal(progress.totalRoundCount, 35); assert.equal(progress.totalRoundLimit, 60);
    assert.equal(progress.segmentRoundCount, 5); assert.equal(progress.segmentRoundLimit, 30);
    assert.equal(progress.toolCount, 50); assert.equal(progress.isLimitReached, false);
});
