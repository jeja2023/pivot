'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunState } = require('../server/services/agent-runtime/run-state');
const { createAgentRunErrorHandler } = require('../server/services/agent-runtime/run-error-handler');
const { createAgentDelegateExecutor } = require('../server/services/agent-tools-delegation');
const { createRunBudgetGuard } = require('../server/services/agent-runtime/run-budget-guard');
const { TaskBudget } = require('../server/services/agent-budget');
const { verifyAutomaticTask } = require('../server/services/chat-task-verification');

test('重试的退避时间实际写入运行，不能被状态写入白名单丢弃', async () => {
    const writes = [];
    const state = createRunState({
        queryOne: async () => ({ status: 'planning' }),
        execute: async (sql, args) => { writes.push({ sql, args }); return 1; },
        assertAgentRunStatusTransition() {}, canTransitionAgentRunStatus: () => true,
        publishUserEvent() {}, publishAgentRunEvent: async () => {},
        getAgentRunTitle: () => '重试任务',
        recordAgentEvent: async () => {}, logger: { warn() {} }, TERMINAL_STATUSES: new Set()
    });
    const due = '2026-10-20 09:01:00';
    await state.updateRun('retry-run', { retry_after: due });
    assert.match(writes[0].sql, /retry_after = \?/);
    assert.equal(writes[0].args[0], due);
    await state.updateRunCas('retry-run', ['planning'], { retry_after: due });
    assert.match(writes[1].sql, /retry_after = \?/);
});

test('任务已暂停或进入审批提交边界后迟到异常不能触发自动重试', async () => {
    for (const status of ['needs_input', 'approval_required', 'awaiting_commit', 'completed']) {
        let writes = 0;
        const handler = createAgentRunErrorHandler({
            logger: { error() {}, warn() {} }, getRunStatus: async () => status,
            isRunCancelled: () => false, TERMINAL_STATUSES: new Set(['completed']),
            updateRun: async () => { writes += 1; }, loadRetryRow: async () => { throw new Error('不得重试'); }
        });
        await handler.handle(new Error('旧执行器迟到异常'), { runId: 'race-run', user: { id: 7 } });
        assert.equal(writes, 0);
    }
});

test('Token 刚好用完以及零额度均在下一次模型请求前拦截', () => {
    for (const limit of [0, 10]) {
        const budget = new TaskBudget({ max_tokens_total: limit });
        if (limit) budget.recordTokens(limit);
        const guard = createRunBudgetGuard({ deadline: Date.now() + 30000, taskBudget: budget });
        assert.throws(guard, error => error.code === 'AGENT_BUDGET_EXCEEDED' && error.details.key === 'max_tokens_total');
    }
});

test('累计 Token 已耗尽时错误收尾只保存可用结果，不再请求额外总结', async () => {
    const budget = new TaskBudget({ max_tokens_total: 10 });
    budget.recordTokens(10);
    const updates = [];
    const handler = createAgentRunErrorHandler({
        logger: { error() {}, warn() {} }, getRunStatus: async () => 'planning',
        isRunCancelled: () => false, TERMINAL_STATUSES: new Set(), getBeijingTimestamp: () => '2026-10-20 09:00:00',
        synthesizeFinalAnswer: async () => { throw new Error('耗尽后不得追加总结'); },
        withTimeout: async () => { throw new Error('耗尽后不得启动模型'); },
        updateRun: async (_id, fields) => updates.push(fields), createAgentNotification: async () => {}
    });
    await handler.handle(Object.assign(new Error('额度耗尽'), { code: 'AGENT_BUDGET_EXCEEDED' }), {
        runId: 'budget-run', user: { id: 7 }, taskBudget: budget, modelCfgForSummary: { id: 1 }, runForSummary: { goal: '查询资料' }
    });
    assert.equal(updates[0].status, 'completed_with_errors');
});

test('语义验收遵从暂停信号并避免在预算用完后发起模型调用', async () => {
    const controller = new AbortController();
    const base = { run: { id: 'verify-run', model_id: 1 }, user: { id: 7 }, contract: { acceptance: {}, deliverables: [] }, answer: '答案' };
    const error = Object.assign(new Error('已暂停'), { code: 'AGENT_RUN_PAUSED' });
    await assert.rejects(() => verifyAutomaticTask({ ...base, signal: controller.signal }, {
        getModel: async () => ({}), callModelJson: async (_model, _messages, options) => {
            controller.abort(error);
            assert.equal(options.signal.aborted, true);
            return '{"passed":true,"coveredDeliverables":[],"missing":[]}';
        }
    }), value => value === error);
    const result = await verifyAutomaticTask({ ...base, budget: new TaskBudget({ max_tokens_total: 0 }) }, {
        getModel: async () => ({}), callModelJson: async () => { throw new Error('无额度不能验收'); }
    });
    assert.equal(result.reason, 'budget_exceeded');
});

test('委派结构化修复按两次真实模型输出分别计费，修复失败也保留原始用量', async () => {
    for (const repaired of ['{"ok":true}', '仍是无效结果']) {
        const records = [];
        const executor = createAgentDelegateExecutor({
            callModelText: async () => repaired,
            recordAgentModelUsage: async (_user, _model, _messages, output, source) => { records.push({ output, source }); },
            chooseAgentLlmModel: async () => ({ id: 1 }), clampText: value => value,
            fitMessagesToContextBudget: messages => ({ messages, metadata: {} }),
            isNativeStructuredOutputUnsupported: () => false, normalizeJsonSchema: value => value || {},
            requestStructuredOutput: async () => ({ content: '原始无效结果', native: true }),
            resolveWorkflowMaxTokens: () => 1000, schemaHasRules: () => false,
            validateJsonSchemaDefinition: () => [], validateStructuredOutput: value => ({ value, issues: value.startsWith('{') ? [] : ['无效 JSON'] })
        });
        const work = executor({ task: '输出结构化结果', agentName: '核对员', responseFormat: 'json' }, { id: 7 }, { runId: 'delegate-run' });
        if (repaired.startsWith('{')) await work;
        else await assert.rejects(() => work, error => error.code === 'AGENT_DELEGATE_OUTPUT_INVALID');
        assert.deepEqual(records, [{ output: '原始无效结果', source: 'agent_delegate' }, { output: repaired, source: 'agent_delegate_json_repair' }]);
    }
});
