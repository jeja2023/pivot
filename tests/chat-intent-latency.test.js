'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveChatIntent } = require('../server/services/chat-intent-resolver');
const { decideAutomaticChatExecution } = require('../server/services/chat-auto-execution-handler');
const { createChatIntentBudget } = require('../server/services/chat-intent-budget');

const input = { prompt: '请修复项目并运行测试', user: { id: 9 }, sessionId: 'latency', modelCfg: { id: 8 } };
const task = { action: 'agent_run', objective: '修复项目并运行测试', requiredCapabilities: ['filesystem.read_workspace', 'code.execute'], routing: { knowledge: 'none', tools: 'task' } };
const config = { mode: 'active', rolloutPercent: 100, timeoutMs: 1000, modelId: 0 };
const deps = { config, callModelJson: async () => task, recordDecision() {} };

test('经验策略读取卡住不会把已验证的语义结果变成总超时', async () => {
    let learningSignal;
    const result = await resolveChatIntent(input, { ...deps, config: { ...config, timeoutMs: 200 },
        resolveBusinessDecision: async options => { learningSignal = options.signal; return new Promise(() => {}); } });
    assert.equal(result.failureCode, undefined);
    assert.equal(result.action, 'agent_run');
    assert.equal(result.textOnlyFallback, undefined);
    assert.equal(learningSignal.aborted, true);
    assert.ok(result.durationMs < 200);
});

test('预算接近截止时跳过可选工作，保留总截止和取消边界', async () => {
    const budget = createChatIntentBudget({ timeoutMs: 30 });
    let invoked = false;
    try {
        assert.equal(await budget.run('optional', () => { invoked = true; }, { optional: true, fallback: 'skipped' }), 'skipped');
        assert.equal(invoked, false);
        assert.equal(budget.signal.aborted, false);
    } finally { budget.dispose(); }
    const controller = new AbortController();
    const cancelled = createChatIntentBudget({ signal: controller.signal, timeoutMs: 30 });
    controller.abort(new Error('已取消'));
    try { await assert.rejects(cancelled.run('optional', () => {}, { optional: true }), /已取消/); }
    finally { cancelled.dispose(); }
});

test('总预算超时保留模型排队或上游阶段，迟到结果不能启动任务', async () => {
    for (const phase of ['model_queue', 'model_provider']) {
        let release;
        const result = await decideAutomaticChatExecution({ ...input, userId: 9, modelContent: input.prompt, sessionsRepository: { listMessages: async () => [] } }, {
            config: { timeoutMs: 100 }, getConversationTasks: async () => [], retrieveLongTermMemories: async () => [],
            getChatCapabilityAvailability: async () => ({ tools: [] }),
            resolveChatIntent: options => resolveChatIntent(options, { ...deps, callModelJson: (_model, _messages, options) => {
                options.usageRef.queueStartedAt = Date.now() - 10;
                if (phase === 'model_provider') options.usageRef.providerStartedAt = Date.now();
                return new Promise(resolve => { release = resolve; });
            } })
        });
        assert.equal(result.failureCode, 'intent_timeout');
        assert.equal(result.failureStage, phase);
        assert.equal(result.textOnlyFallback, true);
        assert.equal(result.requiredCapabilities.length, 0);
        assert.ok(result.timing.queueMs >= 10);
        release(task);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(result.action, 'direct_answer');
    }
});

test('专用路由模型按当前账号查询、使用自身额度和计量，保持回答模型不变', async () => {
    const calls = [];
    const result = await resolveChatIntent(input, { ...deps, config: { ...config, modelId: 22 },
        getAccessibleModelAsync: async (id, user) => { assert.equal(id, 22); assert.equal(user.id, 9); return { id: 22, max_input_tokens: 100000 }; },
        ensureModelQuota: async (user, model) => { calls.push(['quota', user.id, model.id]); return () => calls.push(['release']); },
        callModelJson: async model => { calls.push(['model', model.id]); return task; },
        recordAgentModelUsage: async (_user, model, _messages, _content, source, runId, options) => {
            calls.push(['usage', model.id]); assert.equal(source, 'chat_intent'); assert.equal(runId, ''); assert.equal(options.deferCalibration, true);
        }
    });
    assert.equal(result.intentModelId, 22);
    assert.equal(result.modelId, 8);
    assert.equal(result.routingModelSource, 'dedicated');
    assert.deepEqual(calls, [['quota', 9, 22], ['model', 22], ['usage', 22], ['release']]);
});

test('专用模型无权、凭据不可用或窗口不足时沿用当前模型，不裁剪授权上下文', async () => {
    for (const candidate of [null, { id: 22, secret_error: 'secret' }, { id: 22, max_input_tokens: 100 }]) {
        const result = await resolveChatIntent(input, { ...deps, config: { ...config, modelId: 22 }, getAccessibleModelAsync: async () => candidate,
            callModelJson: async model => { assert.equal(model.id, 8); return task; } });
        assert.equal(result.intentModelId, 8);
        assert.match(result.routingModelSource, /^fallback_/);
        assert.equal(result.failureCode, undefined);
        assert.doesNotMatch(JSON.stringify(result), /secret/);
    }
});

test('专用模型额度不足时不调用上游，不绕过额度执行任务', async () => {
    let calls = 0;
    const result = await resolveChatIntent(input, { ...deps, config: { ...config, modelId: 22 }, getAccessibleModelAsync: async () => ({ id: 22, max_input_tokens: 100000 }),
        ensureModelQuota: async () => { throw Object.assign(new Error('quota'), { code: 'INSUFFICIENT_QUOTA' }); },
        callModelJson: async () => { calls++; return task; } });
    assert.equal(calls, 0);
    assert.equal(result.textOnlyFallback, true);
    assert.equal(result.action, 'direct_answer');
});

test('专用模型查询超时后沿用当前模型，迟到查询不改变已完成判断', async () => {
    let release;
    const result = await resolveChatIntent(input, { ...deps, config: { ...config, modelId: 22, timeoutMs: 200 },
        getAccessibleModelAsync: () => new Promise(resolve => { release = resolve; }) });
    assert.equal(result.failureCode, undefined);
    assert.equal(result.intentModelId, 8);
    assert.equal(result.routingModelSource, 'fallback_unavailable');
    release({ id: 22 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.intentModelId, 8);
});

test('路由耗时只按诊断字段持久化，不写入提示词等任意元数据', async () => {
    const { queryOne, execute } = require('../server/db/client');
    const { recordDecision, flushPendingDecisionObservability } = require('../server/services/decision-observability');
    const user = await queryOne("SELECT id FROM users WHERE username = 'admin'");
    const id = `intent-timing-${process.pid}-${Date.now()}`;
    try {
        recordDecision({ decisionId: id, userId: user.id, context: { scenario: 'chat.execution' }, selectedActionId: 'direct_answer',
            providerOutputs: [{ providerId: 'chat-intent', providerVersion: '8', selectedActionId: 'direct_answer', error: 'intent_timeout',
                metadata: { failureStage: 'model_queue', timing: { queueMs: 25000, providerMs: 5000, prompt: 'private-input' }, prompt: 'private-input' } }] });
        await flushPendingDecisionObservability();
        const row = await queryOne('SELECT provider_outputs FROM decision_records WHERE decision_id = ?', [id]);
        const outputs = typeof row.provider_outputs === 'string' ? JSON.parse(row.provider_outputs) : row.provider_outputs;
        assert.deepEqual(outputs[0].metadata.timing, { queueMs: 25000, providerMs: 5000 });
        assert.equal(outputs[0].metadata.failureStage, 'model_queue');
        assert.doesNotMatch(JSON.stringify(outputs), /private-input/);
    } finally { await execute('DELETE FROM decision_records WHERE decision_id = ?', [id]); }
});

test('非计费校准写入延迟不阻塞路由，令牌记账仍先入队', async () => {
    const filename = path.resolve(__dirname, '../server/services/agent-model.js');
    const module = { exports: {} };
    const recorded = [];
    let finishCalibration;
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, require(name) {
        if (name === './models') return { ...require('../server/services/models'), recordModelTokenUsage: (...args) => recorded.push(args) };
        if (name === './provider-usage-calibration') return { estimateProviderUsage: () => ({ inputTokens: 12, outputTokens: 3 }),
            recordProviderUsageCalibration: () => new Promise(resolve => { finishCalibration = resolve; }) };
        return name.startsWith('.') ? require(path.resolve(path.dirname(filename), name)) : require(name);
    }, process, AbortController, setTimeout, clearTimeout });
    const result = await module.exports.recordAgentModelUsage({ id: 9 }, { id: 8 }, [], 'result', 'chat_intent', '',
        { deferCalibration: true, usage: { prompt_tokens: 20, completion_tokens: 4 } });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0][2], 24);
    assert.equal(result.totalTokens, 24);
    assert.equal(result.calibration, null);
    finishCalibration({ complete: true });
});
