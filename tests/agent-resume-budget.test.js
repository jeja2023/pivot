'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { getRunForUser } = require('../server/services/agent-runs');
const { getAgentRunTitle, getRunMetadata } = require('../server/services/agent-runtime/metadata');
const { createAgentRunFactory } = require('../server/services/agent-runtime/run-creation');
const { createRunLifecycle } = require('../server/services/agent-runtime/run-lifecycle');
const { ACTIVE_STATUSES, normalizeDagSpec, normalizeToolAllowlist, parseJsonObject } = require('../server/services/agent-validators');
const { getAgentRunResources, recordAgentRunResourceUsage, reserveChildRunResources } = require('../server/services/agent-run-resources');
const { resumeWaitingConversationTask } = require('../server/services/chat-task-continuation');
const { recordAgentModelUsage } = require('../server/services/agent-model');
const { TaskBudget } = require('../server/services/agent-budget');

const skipWithoutDatabase = { skip: !process.env.DATABASE_URL };

async function fixture(options = {}) {
    const user = await queryOne('SELECT id, username, role, status FROM users ORDER BY id LIMIT 1');
    const model = await queryOne("INSERT INTO models (user_id, name, url, model_name, status) VALUES (?, '续跑预算测试', 'https://example.invalid/v1/chat/completions', 'resume-budget-test', 'active') RETURNING id", [user.id]);
    const ids = [];
    let enqueued = 0;
    const create = createAgentRunFactory();
    const trackedCreate = async input => { const run = await create(input); ids.push(run.id); return run; };
    const original = await trackedCreate({
        user, modelId: model.id, goal: '从已有检查点继续处理资料', maxTokenBudget: 2048000,
        budgetConfig: { max_tokens_total: 2048000, max_tool_calls: 17, risk_budget: 3 },
        metadata: { autoPersonalSkill: false }, ...options
    });
    await recordAgentRunResourceUsage(original.id, 312587);
    await execute("UPDATE agent_runs SET status = ?, total_tokens = 312587 WHERE id = ?", [options.runMode === 'dag' ? 'error' : 'needs_input', original.id]);
    const lifecycle = createRunLifecycle({
        ACTIVE_STATUSES, getRunForUser, getRunMetadata, getAgentRunTitle, normalizeToolAllowlist, parseJsonObject,
        normalizeDagSpec, createAgentRun: trackedCreate, isChatAgentRun: run => Boolean(getRunMetadata(run).chatBridge),
        resumeWaitingConversationTask: (run, owner) => resumeWaitingConversationTask(run, owner, {
            enqueueAgentRun: () => { enqueued += 1; }, buildAgentResumeContext: async () => ({ latestStepIndex: 3 })
        }),
        listSteps: async () => [{ id: 1, step_index: 3, status: 'success' }],
        listDagNodes: async () => [{ node_key: 'node', status: 'error', output: null }],
        buildAgentResumeContext: async () => ({ latestStepIndex: 3 }),
        clampText: (text, limit) => text.slice(0, limit)
    });
    return { original, user, lifecycle, create: trackedCreate, getEnqueued: () => enqueued, async cleanup() {
        for (const id of ids.reverse()) await execute('DELETE FROM agent_runs WHERE id = ?', [id]);
        await execute('DELETE FROM models WHERE id = ?', [model.id]);
    } };
}

test('继续使用父任务扣除已用量及预留后的剩余预算，两层预算一致且不扩权', skipWithoutDatabase, async () => {
    const current = await fixture();
    try {
        // 其他子任务已预留的额度也不能重复分配给续跑。
        await reserveChildRunResources({ parentRunId: current.original.id, userId: current.user.id, requestedTokenBudget: 100000 });
        const resumed = await current.lifecycle.resumeAgentRun(current.original.id, current.user);
        assert.equal(resumed.parent_run_id, current.original.id);
        assert.equal(Number(resumed.max_token_budget), 1635413);
        assert.equal(parseJsonObject(resumed.budget_config).max_tokens_total, 1635413);
        assert.equal(parseJsonObject(resumed.budget_config).max_tool_calls, 17);
        assert.equal(parseJsonObject(resumed.budget_config).risk_budget, 3);
        assert.equal(resumed.resume_from_step, 3);
        assert.equal(getRunMetadata(resumed).resumedFromRunId, current.original.id);
        const ledger = await getAgentRunResources(current.original.id, current.user.id);
        assert.equal(Number(ledger.tokens_reserved), 1735413);
        assert.equal(Number(ledger.tokens_consumed), 312587);
        assert.equal(Number(ledger.token_budget), 2048000);
    } finally { await current.cleanup(); }
});

test('聊天等待补充时并发点击继续复用原任务，不创建子运行或重复预留预算', skipWithoutDatabase, async () => {
    const current = await fixture({ metadata: { autoPersonalSkill: false, chatBridge: { version: 1 } } });
    try {
        const results = await Promise.all([current.lifecycle.resumeAgentRun(current.original.id, current.user), current.lifecycle.resumeAgentRun(current.original.id, current.user)]);
        assert.ok(results.every(run => run.id === current.original.id && run.status === 'queued'));
        const run = results[0];
        assert.equal(run.parent_run_id, null);
        assert.equal(run.resume_from_step, 3);
        assert.equal(Number(run.total_tokens), 312587);
        assert.equal(Number(run.max_token_budget), 2048000);
        assert.equal(current.getEnqueued(), 1);
        const ledger = await getAgentRunResources(run.id, current.user.id);
        assert.equal(Number(ledger.tokens_reserved), 0);
        assert.equal(Number(ledger.active_children), 0);
        assert.equal(Number(ledger.tokens_consumed), 312587);
        assert.equal((await current.lifecycle.resumeAgentRun(run.id, current.user)).id, run.id);
        assert.equal(current.getEnqueued(), 1);
    } finally { await current.cleanup(); }
});

test('聊天任务真正耗尽时拒绝恢复并说明操作，不通过新建子任务重置额度', skipWithoutDatabase, async () => {
    const current = await fixture({ metadata: { autoPersonalSkill: false, chatBridge: { version: 1 } }, budgetConfig: { max_tokens_total: 312587 } });
    try {
        await assert.rejects(() => current.lifecycle.resumeAgentRun(current.original.id, current.user), error => error.code === 'AGENT_BUDGET_EXCEEDED' && error.status === 409 && /缩小资料范围/.test(error.message));
        assert.equal(current.getEnqueued(), 0);
        assert.equal(Number((await getAgentRunResources(current.original.id, current.user.id)).tokens_reserved), 0);
    } finally { await current.cleanup(); }
});

test('旧聊天卡片继续时找到已存在的续跑任务，父额度已预留也不会再次申请', skipWithoutDatabase, async () => {
    const current = await fixture({ metadata: { autoPersonalSkill: false, chatBridge: { version: 1 } } });
    try {
        const child = await current.create({ user: current.user, modelId: current.original.model_id, goal: '继续检索资料', parentRunId: current.original.id,
            metadata: { autoPersonalSkill: false, chatBridge: { version: 1 }, resumedFromRunId: current.original.id } });
        await execute("UPDATE agent_runs SET status = 'needs_input' WHERE id = ?", [child.id]);
        const resumed = await current.lifecycle.resumeAgentRun(current.original.id, current.user);
        assert.equal(resumed.id, child.id);
        assert.equal(resumed.status, 'queued');
        assert.equal(current.getEnqueued(), 1);
        const ledger = await getAgentRunResources(current.original.id, current.user.id);
        assert.equal(Number(ledger.active_children), 1);
        assert.equal(Number(ledger.tokens_reserved), 1735413);
    } finally { await current.cleanup(); }
});

test('聊天终态重跑建立新的消息与验收关联，不能继承父任务的已回写标记', skipWithoutDatabase, async () => {
    const current = await fixture({ metadata: { autoPersonalSkill: false, chatBridge: { version: 1 } } });
    try {
        await execute("UPDATE agent_runs SET status = 'error', metadata = ?::jsonb WHERE id = ?", [JSON.stringify({
            autoPersonalSkill: false, chatBridge: { version: 1, messageId: 123, persistedAt: '2026-10-20 08:00:00' },
            taskVerification: { outcomeStatus: 'needs_input' }, taskTransactionId: 'parent-transaction', taskTransactionStatus: 'needs_input'
        }), current.original.id]);
        const child = await current.lifecycle.resumeAgentRun(current.original.id, current.user);
        const metadata = getRunMetadata(child);
        assert.notEqual(child.id, current.original.id);
        assert.equal(metadata.chatBridge.messageId, undefined);
        assert.equal(metadata.chatBridge.persistedAt, undefined);
        assert.equal(metadata.taskVerification, undefined);
        assert.equal(metadata.taskTransactionId, undefined);
    } finally { await current.cleanup(); }
});

test('模型调用越过持久化限额时仍同步内存用量，错误收尾不会误判剩余额度', skipWithoutDatabase, async () => {
    const current = await fixture({ budgetConfig: { max_tokens_total: 312587 } });
    try {
        const budget = new TaskBudget({ max_tokens_total: 312587 });
        budget.counts.tokens_total = 312587;
        await assert.rejects(() => recordAgentModelUsage(current.user, { id: current.original.model_id }, [], '结果', 'agent_usage_regression', current.original.id, {
            usage: { prompt_tokens: 10, completion_tokens: 5 }, budget
        }), error => error.code === 'AGENT_BUDGET_EXCEEDED');
        assert.equal(budget.counts.tokens_total, 312602);
        const ledger = await getAgentRunResources(current.original.id, current.user.id);
        assert.equal(Number(ledger.tokens_consumed), 312602);
    } finally { await current.cleanup(); }
});

test('复现日志中的 2048000 总预算与 1735413 剩余预算，继续能成功创建运行', skipWithoutDatabase, async () => {
    const current = await fixture();
    try {
        const resumed = await current.lifecycle.resumeAgentRun(current.original.id, current.user);
        assert.equal(Number(resumed.max_token_budget), 1735413);
        assert.equal(parseJsonObject(resumed.budget_config).max_tokens_total, 1735413);
        await assert.rejects(() => current.lifecycle.resumeAgentRun(current.original.id, current.user), error => {
            assert.equal(error.code, 'AGENT_CHILD_BUDGET_EXCEEDED');
            assert.equal(error.status, 409);
            return true;
        });
    } finally { await current.cleanup(); }
});

test('工作流节点重跑与完整重跑同样继承剩余预算', skipWithoutDatabase, async () => {
    for (const mode of ['rerun', 'dag']) {
        const current = await fixture(mode === 'dag' ? {
            runMode: 'dag', dagSpec: { nodes: [{ id: 'node', tool: 'workflow.template', input: { template: '测试' } }] }
        } : {});
        try {
            await execute("UPDATE agent_runs SET status = 'error' WHERE id = ?", [current.original.id]);
            const resumed = mode === 'dag'
                ? await current.lifecycle.resumeAgentRun(current.original.id, current.user)
                : await current.lifecycle.rerunAgentRun(current.original.id, current.user);
            assert.equal(Number(resumed.max_token_budget), 1735413);
            assert.equal(parseJsonObject(resumed.budget_config).max_tokens_total, 1735413);
        } finally { await current.cleanup(); }
    }
});

test('显式子任务超额仍拒绝，实际耗尽返回冲突提示而不是内部错误', skipWithoutDatabase, async () => {
    const current = await fixture();
    try {
        await assert.rejects(() => reserveChildRunResources({
            parentRunId: current.original.id, userId: current.user.id, requestedTokenBudget: 2048000
        }), error => error.code === 'AGENT_CHILD_BUDGET_EXCEEDED' && error.status === 409);
        const ledger = await getAgentRunResources(current.original.id, current.user.id);
        assert.equal(Number(ledger.tokens_reserved), 0);
        assert.equal(Number(ledger.active_children), 0);
        await recordAgentRunResourceUsage(current.original.id, 1735413);
        await assert.rejects(() => current.lifecycle.resumeAgentRun(current.original.id, current.user),
            error => error.code === 'AGENT_CHILD_BUDGET_EXCEEDED' && error.status === 409);
    } finally { await current.cleanup(); }
});

test('子任务显式的小预算和零预算不会因继承剩余额度而扩大', skipWithoutDatabase, async () => {
    const current = await fixture();
    try {
        for (const limit of [5000, 0]) {
            const child = await current.create({ user: current.user, modelId: current.original.model_id,
                goal: '保留显式运行约束', parentRunId: current.original.id, maxTokenBudget: 10000,
                metadata: { autoPersonalSkill: false }, budgetConfig: { max_tokens_total: limit } });
            assert.equal(parseJsonObject(child.budget_config).max_tokens_total, limit);
        }
    } finally { await current.cleanup(); }
});

test('父任务总预算更紧时按更紧预算扣除已用量，显式零额度不能被续跑绕过', skipWithoutDatabase, async () => {
    for (const limit of [350000, 0]) {
        const current = await fixture({ budgetConfig: { max_tokens_total: limit } });
        try {
            if (limit === 0) {
                await assert.rejects(() => current.lifecycle.resumeAgentRun(current.original.id, current.user),
                    error => error.code === 'AGENT_CHILD_BUDGET_EXCEEDED' && error.status === 409);
            } else {
                const resumed = await current.lifecycle.resumeAgentRun(current.original.id, current.user);
                assert.equal(Number(resumed.max_token_budget), 37413);
                assert.equal(parseJsonObject(resumed.budget_config).max_tokens_total, 37413);
            }
        } finally { await current.cleanup(); }
    }
});

test('并发点击继续只分配一次剩余额度，失败请求不会遗留预算预留', skipWithoutDatabase, async () => {
    const current = await fixture();
    try {
        const results = await Promise.allSettled([
            current.lifecycle.resumeAgentRun(current.original.id, current.user),
            current.lifecycle.resumeAgentRun(current.original.id, current.user)
        ]);
        assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
        const failure = results.find(item => item.status === 'rejected').reason;
        assert.equal(failure.code, 'AGENT_CHILD_BUDGET_EXCEEDED');
        assert.equal(failure.status, 409);
        const ledger = await getAgentRunResources(current.original.id, current.user.id);
        assert.equal(Number(ledger.active_children), 1);
        assert.equal(Number(ledger.tokens_reserved), 1735413);
        assert.equal(Number(ledger.tokens_consumed), 312587);
    } finally { await current.cleanup(); }
});
