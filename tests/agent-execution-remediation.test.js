'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { queryOne, execute, query } = require('../server/db/client');
const { createChatFixture } = require('./security-chat/chat-route-harness');
const { createAgentRunFactory } = require('../server/services/agent-runtime/run-creation');
const { createRunLifecycle } = require('../server/services/agent-runtime/run-lifecycle');
const { createRunState } = require('../server/services/agent-runtime/run-state');
const { runs } = require('../server/services/agent-runtime');
const { ACTIVE_STATUSES, normalizeToolAllowlist, parseJsonObject } = require('../server/services/agent-validators');
const { TERMINAL_STATUSES, assertAgentRunStatusTransition } = require('../server/services/agent-runtime/state-machine');
const { getBeijingTimestamp } = require('../server/time');
const { recordModelTokenUsage, getModelDailyUsageAsync } = require('../server/services/models');
const { createTaskTransaction, getTaskTransactionForUser, transitionTaskTransaction, recordTaskTransactionVerification } = require('../server/services/agent-task-transactions');
const { executeAndCommitTaskTransaction } = require('../server/services/agent-task-effect-executor');
const { normalizeTaskContract } = require('../server/services/agent-verification');
const { requestedDeliveryFormats } = require('../server/services/task-display-title');

const createRun = createAgentRunFactory({ createTaskTransaction });
const row = id => queryOne('SELECT * FROM agent_runs WHERE id = ?', [id]);
const outputNode = { id: 'out', tool: 'workflow.output', input: { name: '摘要', value: '合成摘要' } };

async function mockModel(t, handler) {
    const server = http.createServer((req, res) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => handler(JSON.parse(data), res));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    return 'http://127.0.0.1:' + server.address().port + '/v1';
}

const reply = (res, content, tokens = 40) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: tokens - 5, completion_tokens: 5, total_tokens: tokens }
}));

test('接纳提交前队列看不到运行，幂等重试在初始化成功后读取同一记录', async () => {
    const f = createChatFixture({ prefix: 'agent_atomic_admission' });
    const entered = Promise.withResolvers(), proceed = Promise.withResolvers();
    const factory = createAgentRunFactory({ createTaskTransaction: async (input, trx) => {
        entered.resolve(input.run.id);
        await proceed.promise;
        return createTaskTransaction(input, trx);
    } });
    const options = { user: f.user, modelId: f.modelId, goal: '合成任务接纳', dedupeKey: randomUUID(), metadata: { autoPersonalSkill: false } };
    const pending = factory(options);
    try {
        const id = await entered.promise;
        const repeated = factory(options);
        assert.equal(await row(id), null);
        proceed.resolve();
        const [first, second] = await Promise.all([pending, repeated]);
        assert.equal(first.id, second.id);
        assert.ok((await row(first.id)).metadata.taskTransactionId);
        const fail = createAgentRunFactory({ createTaskTransaction: async () => { throw new Error('模拟事务写入失败'); } });
        await assert.rejects(fail({ ...options, dedupeKey: (options.dedupeKey + '-failed'), parentRunId: id }), /模拟事务写入失败/);
        const ledger = await queryOne('SELECT active_children,tokens_reserved FROM agent_run_resources WHERE run_id = ?', [id]);
        assert.equal(Number(ledger.active_children), 0);
        assert.equal(Number(ledger.tokens_reserved), 0);
    } finally { proceed.resolve(); await pending.catch(() => {}); f.cleanup(); }
});

test('普通 JSON 与流式任务在日限额耗尽时均不连接模型', async t => {
    let upstream = 0;
    const url = await mockModel(t, (_, res) => { upstream++; reply(res, '{}'); });
    const f = createChatFixture({ prefix: 'agent_daily_limit', upstreamUrl: url,
        modelColumns: { daily_token_limit: 50, max_input_tokens: 64000, supports_tool_calls: true, tool_call_mode: 'enabled' } });
    const original = process.env.AGENT_STREAMING_TOOLS;
    try {
        await recordModelTokenUsage(f.userId, f.modelId, 55, 'audit');
        for (const stream of ['false', 'true']) {
            process.env.AGENT_STREAMING_TOOLS = stream;
            const run = await createRun({ user: f.user, modelId: f.modelId, goal: '核对合成材料', retryLimit: 0, metadata: { autoPersonalSkill: false } });
            await runs.runAgent(run.id, f.user);
            assert.equal((await row(run.id)).status, 'error');
        }
        assert.equal(upstream, 0);
        assert.equal(await getModelDailyUsageAsync(f.userId, f.modelId), 55);
    } finally {
        if (original === undefined) delete process.env.AGENT_STREAMING_TOOLS; else process.env.AGENT_STREAMING_TOOLS = original;
        f.cleanup();
    }
});

test('DAG 大模型节点先扣输入预算，实际用量进入同一预算快照', async t => {
    let requests = 0;
    const url = await mockModel(t, (_, res) => { requests++; reply(res, '合成摘要'); });
    const f = createChatFixture({ prefix: 'agent_dag_budget', upstreamUrl: url, modelColumns: { max_input_tokens: 64000, max_tokens: 128 } });
    const nodes = [{ id: 'first', tool: 'agent.llm', input: { model: String(f.modelId), prompt: '{{goal}}', maxTokens: 40 } },
        { id: 'second', tool: 'agent.llm', dependsOn: ['first'], input: { model: String(f.modelId), prompt: '{{goal}}。' + '合成说明。'.repeat(160), maxTokens: 40 } }];
    try {
        const run = await createRun({ user: f.user, modelId: f.modelId, runMode: 'dag', goal: '总结合成说明',
            dagSpec: { nodes, cacheEnabled: false }, budgetConfig: { max_tokens_total: 450 }, retryLimit: 0 });
        await runs.runAgent(run.id, f.user);
        const saved = await row(run.id);
        assert.equal(requests, 1, saved.error_message);
        assert.equal(Number(saved.total_tokens), 40);
        assert.equal(saved.usage_stats.counts.tokens_total, 40);
    } finally { f.cleanup(); }
});

test('DAG 核验期间暂停会取消模型并保留暂停状态、旧事务和空核验记录', async t => {
    const entered = Promise.withResolvers(), closed = Promise.withResolvers();
    const url = await mockModel(t, (_, res) => { res.once('close', closed.resolve); entered.resolve(); });
    const f = createChatFixture({ prefix: 'agent_dag_verify_pause', upstreamUrl: url, modelColumns: { max_input_tokens: 64000 } });
    const run = await createRun({ user: f.user, modelId: f.modelId, runMode: 'dag', goal: '生成合成报告', dagSpec: { nodes: [outputNode] },
        taskContract: { acceptance: { requireSemanticVerification: true } } });
    const execution = runs.runAgent(run.id, f.user);
    try {
        await Promise.race([entered.promise, execution.then(() => { throw new Error('任务未进入独立核验'); })]);
        assert.equal((await runs.pauseAgentRun(run.id, f.user)).status, 'needs_input');
        await execution;
        await closed.promise;
        assert.equal(await queryOne('SELECT id FROM agent_verifications WHERE run_id = ?', [run.id]), null);
        assert.equal((await row(run.id)).status, 'needs_input');
        assert.equal((await getTaskTransactionForUser(run.metadata.taskTransactionId, f.user)).status, 'executing');
    } finally { await execution.catch(() => {}); f.cleanup(); }
});

test('交付契约归一化两次仍要求所有显式格式，来源文件类型不算交付要求', () => {
    assert.deepEqual(requestedDeliveryFormats('请制作 PPTX 并同时导出 PDF。'), ['pptx', 'pdf']);
    assert.deepEqual(requestedDeliveryFormats('请分析 PDF 附件并生成摘要。'), []);
    const contract = normalizeTaskContract({ acceptance: { requiredFormats: ['PPTX', 'pdf', '../bad', 'pdf'] } });
    assert.equal(contract.acceptance.artifactRequired, true);
    assert.deepEqual(normalizeTaskContract(contract).acceptance.requiredFormats, ['pptx', 'pdf']);
});

test('已提交事务重试使用原回执，完成任务状态且不执行副作用', async () => {
    const f = createChatFixture({ prefix: 'agent_commit_receipt' });
    try {
        const run = await createRun({ user: f.user, modelId: f.modelId, goal: '核对合成回执' });
        const id = run.metadata.taskTransactionId;
        await transitionTaskTransaction(id, f.user, 'executing');
        await recordTaskTransactionVerification(id, f.user, { outcomeStatus: 'verified' });
        await execute("UPDATE agent_runs SET status = 'awaiting_commit' WHERE id = ?", [run.id]);
        await executeAndCommitTaskTransaction(id, f.user);
        const receipt = await executeAndCommitTaskTransaction(id, f.user);
        assert.equal(receipt.status, 'committed');
        assert.equal((await row(run.id)).status, 'awaiting_commit');
        await runs.recoverAgentRuns();
        assert.equal((await row(run.id)).status, 'completed');
    } finally { f.cleanup(); }
});

test('超时保留预算诊断和部分状态，而非登记用户取消', async t => {
    const url = await mockModel(t, () => {});
    const f = createChatFixture({ prefix: 'agent_task_deadline', upstreamUrl: url, modelColumns: { max_input_tokens: 64000 } });
    try {
        const run = await createRun({ user: f.user, modelId: f.modelId, goal: '核对总时限', retryLimit: 0, budgetConfig: { max_runtime_seconds: 2 } });
        await runs.runAgent(run.id, f.user);
        const saved = await row(run.id);
        assert.equal(saved.status, 'completed_with_errors', saved.error_message);
        assert.match(saved.error_message, /超时|运行时间/);
        assert.ok(saved.metadata.budgetStop);
    } finally { f.cleanup(); }
});

test('监控渠道首次入队故障回滚摘要，恢复后仅生成一份投递', async () => {
    const { createAgentChannel } = require('../server/services/agent-channels');
    const { createAgentGoal, deliverGoalRunResult, recoverGoalRunDeliveries } = require('../server/services/agent-goals');
    const f = createChatFixture({ prefix: 'agent_monitor_recover' });
    const channel = await createAgentChannel(f.user, { channelType: 'web', channelKey: randomUUID() });
    const { goal } = await createAgentGoal(f.user, { title: '合成监控', goal: '检查合成材料', kind: 'monitor', triggerSpec: { type: 'manual' },
        authorizationSpec: { modelId: f.modelId, deliveryBindingIds: [channel.id] } });
    try {
        const run = await createRun({ user: f.user, modelId: f.modelId, goal: '检查合成材料', metadata: { source: 'goal', goalId: goal.id,
            goalDeliveryPending: true, goalDelivery: { bindingIds: [channel.id] } } });
        await execute("UPDATE agent_runs SET status = 'completed', final_answer = '摘要已变化' WHERE id = ?", [run.id]);
        await execute("ALTER TABLE agent_channel_deliveries ADD CONSTRAINT agent_test_fail_goal_delivery CHECK (event_type <> 'goal.result') NOT VALID");
        try { await assert.rejects(deliverGoalRunResult(run.id), error => error.code === '23514'); }
        finally { await execute('ALTER TABLE agent_channel_deliveries DROP CONSTRAINT agent_test_fail_goal_delivery'); }
        assert.equal((await queryOne('SELECT last_result_digest FROM agent_goals WHERE id = ?', [goal.id])).last_result_digest.trim(), '');
        await recoverGoalRunDeliveries();
        await recoverGoalRunDeliveries();
        assert.equal((await query('SELECT id FROM agent_channel_deliveries WHERE binding_id = ?', [channel.id])).length, 1);
    } finally {
        await execute('DELETE FROM agent_channel_deliveries WHERE binding_id = ?', [channel.id]);
        await execute('DELETE FROM agent_channel_bindings WHERE id = ?', [channel.id]);
        await execute('DELETE FROM agent_goals WHERE id = ?', [goal.id]);
        f.cleanup();
    }
});

test('断点续跑与整任务重跑继承父任务模型策略', async () => {
    const f = createChatFixture({ prefix: 'agent_resume_model_router' });
    const life = createRunLifecycle({ ACTIVE_STATUSES, getRunForUser: row, getRunMetadata: run => run.metadata, createAgentRun: createRun,
        normalizeToolAllowlist, parseJsonObject, listSteps: async () => [], buildAgentResumeContext: async () => ({ latestStepIndex: 0 }),
        isChatAgentRun: () => false, getAgentRunTitle: run => run.title, clampText: value => value });
    try {
        for (const action of [life.resumeAgentRun, life.rerunAgentRun]) {
            const parent = await createRun({ user: f.user, modelId: f.modelId, goal: '检查可恢复配置', modelRouter: 'auto-quality' });
            await execute("UPDATE agent_runs SET status = 'partial' WHERE id = ?", [parent.id]);
            assert.equal((await action(parent.id, f.user)).model_router, 'auto-quality');
        }
    } finally { f.cleanup(); }
});

test('任务在读取与停止之间被认领也可一次取消', async () => {
    const f = createChatFixture({ prefix: 'agent_cancel_claim' });
    const noop = async () => {};
    const state = createRunState({ queryOne, execute, crypto: require('node:crypto'), TERMINAL_STATUSES, assertAgentRunStatusTransition,
        publishUserEvent: noop, getAgentRunTitle: run => run.title, recordAgentEvent: noop, releaseChildRunReservation: noop,
        persistAgentRunChatResult: noop, recordAgentRunOutcome: noop });
    let changed = false;
    const lifecycle = createRunLifecycle({ ACTIVE_STATUSES, activeRunControllers: new Map(), query, getBeijingTimestamp,
        getAgentRunTitle: run => run.title, listSteps: async () => [], insertStep: noop, createAgentNotification: noop, updateRunCas: state.updateRunCas,
        getRunForUser: async id => {
            const current = await row(id);
            if (!changed) { changed = true; await execute("UPDATE agent_runs SET status = 'running' WHERE id = ?", [id]); }
            return current;
        } });
    try {
        const task = await createRun({ user: f.user, modelId: f.modelId, goal: '核对停止请求' });
        assert.equal((await lifecycle.cancelAgentRun(task.id, f.user)).status, 'cancelled');
    } finally { f.cleanup(); }
});


test('只要同轮预算仍可满足，DAG 并发请求等待已预留份额释放', async () => {
    const { TaskBudget } = require('../server/services/agent-budget');
    const budget = new TaskBudget({ max_tokens_total: 100 });
    const first = await budget.reserveModelRequest(80, 20);
    let entered = false;
    const waiting = budget.reserveModelRequest(20, 40).then(value => { entered = true; return value; });
    await Promise.resolve();
    assert.equal(entered, false);
    budget.recordTokens(50);
    first.release();
    const second = await waiting;
    assert.equal(second.maxTokens, 30);
    second.release();
});

test('统一日额度在上游成功后只结算一次并释放预留', async t => {
    const { callModelJson, recordAgentModelUsage } = require('../server/services/agent-model');
    const { getRunnableModelForUserAsync } = require('../server/services/models');
    const { getInflightQuota } = require('../server/services/model-daily-quota');
    const entered = Promise.withResolvers(), pendingResponse = Promise.withResolvers();
    let calls = 0;
    const url = await mockModel(t, (_, res) => { calls++; entered.resolve(); void pendingResponse.promise.then(() => reply(res, '合成答复')); });
    const f = createChatFixture({ prefix: 'agent_quota_settlement', upstreamUrl: url, modelColumns: { daily_token_limit: 120 } });
    const model = await getRunnableModelForUserAsync(f.modelId, f.user);
    const messages = [{ role: 'user', content: '合成答复' }];
    const usageRef = {};
    const call = callModelJson(model, messages, { user: f.user, maxTokens: 80, usageRef });
    try {
        await Promise.race([entered.promise, call]);
        await assert.rejects(callModelJson(model, messages, { user: f.user, maxTokens: 80 }), { code: 'INSUFFICIENT_QUOTA' });
        assert.ok(getInflightQuota(f.userId, f.modelId) > 0);
        pendingResponse.resolve();
        await recordAgentModelUsage(f.user, model, messages, await call, 'agent', '', { usageRef });
        assert.equal(await getModelDailyUsageAsync(f.userId, f.modelId), 40);
        assert.equal(getInflightQuota(f.userId, f.modelId), 0);
        assert.equal(calls, 1);
    } finally { pendingResponse.resolve(); await call.catch(() => {}); f.cleanup(); }
});

test('工作台发送用户看到的审批标识和记住选项', async () => {
    const fs = require('node:fs');
    const vm = require('node:vm');
    const source = fs.readFileSync(require.resolve('../client/chat/agent-run-actions.js'), 'utf8');
    const start = source.indexOf('window.Pivot.legacy.approveAgentRun =');
    const end = source.indexOf('window.Pivot.legacy.revokeAgentApproval =', start);
    const requests = [];
    const window = { Pivot: { legacy: { openAgentRun: async () => {} } } };
    vm.runInNewContext(source.slice(start, end), { window, document: { getElementById: () => ({ checked: true }) }, API_BASE: '',
        runAgentActionOnce: async (_key, _id, _selectors, action) => await action(),
        apiFetch: async (_url, request) => { requests.push(JSON.parse(request.body)); return { ok: true, json: async () => ({}) }; },
        showToast() {}, loadAgentRuns: async () => {} });
    const binding = { inputHash: 'synthetic-hash', key: 'synthetic-key', requestedAt: '2026-11-20 11:00:00' };
    await window.Pivot.legacy.approveAgentRun('synthetic', true, { binding });
    assert.deepEqual(requests, [{ approve: true, rememberForRun: true, ...binding }]);
});
