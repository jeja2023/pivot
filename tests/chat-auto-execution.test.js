'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyChatAutoExecution } = require('../server/services/chat-auto-execution');
const { resolveChatIntent, normalizeIntent } = require('../server/services/chat-intent-resolver');
const { evaluateToolPolicy } = require('../server/services/agent-policy');
const { verifyTaskOutcome } = require('../server/services/agent-verification');
const { verifyAutomaticTask } = require('../server/services/chat-task-verification');
const { reviewChatAction } = require('../server/services/chat-action-review');
const { createToolOrchestrator } = require('../server/services/agent-tool-orchestrator');

const config = { mode: 'active', timeoutMs: 1000, rolloutPercent: 100 };
const input = { prompt: '请分析附件并生成风险报告', user: { id: 9 }, userMessageId: 11, sessionId: 'test-session', modelCfg: { id: 8 }, history: [] };
const modelDecision = { action: 'agent_run', intent: 'delegate', objective: '分析附件并生成风险报告', constraints: [], deliverables: ['风险报告'], requiredCapabilities: ['data.query','document.render'], missingFacts: [], evidenceRefs: ['current_message'], confidence: 0.2 };
const deps = output => ({ config, callModelJson: async () => JSON.stringify(output), recordDecision() {} });

test('同一句话中的长期偏好不能吞掉当前委托任务', () => {
    assert.equal(classifyChatAutoExecution({ prompt: '以后回答先给结论' }).action, 'memory');
    assert.equal(classifyChatAutoExecution({ prompt: '以后回答先给结论，帮我分析附件并生成报告' }).action, 'agent_run');
});

test('明确短对话保留快速路径，业务问答、讨论和引用可由语义判断后直答', async () => {
    for (const prompt of ['请解释向量检索','请写一份产品发布报告','请翻译这份报告并生成英文版','他让我完成报告的要求是什么？','停止当前任务的功能如何实现？']) {
        assert.equal(classifyChatAutoExecution({ prompt }).action, 'direct_answer', prompt);
        const result = await resolveChatIntent({ ...input, prompt }, deps({ ...modelDecision, objective: prompt, action: 'direct_answer', requiredCapabilities: [], routing: { knowledge: 'none', tools: 'none' } }));
        assert.equal(result.action, 'direct_answer');
    }
    const greeting = await resolveChatIntent({ ...input, prompt: '你好' }, { ...deps(null), callModelJson: async () => { throw new Error('明确短对话不需要分类模型'); } });
    assert.equal(greeting.action, 'direct_answer');
});

test('候选任务以结构化语义结果选择运行，模型自报置信不授予权限', async () => {
    const result = await resolveChatIntent(input, deps(modelDecision));
    assert.equal(result.action, 'agent_run');
    assert.deepEqual(result.evidenceRefs, ['message:11']);
    assert.ok(result.decisionId);
    const direct = await resolveChatIntent(input, deps({ ...modelDecision, action: 'direct_answer' }));
    assert.equal(direct.action, 'direct_answer', '候选规则不得推翻主模型的处理方式');
});

test('续接必须指向当前会话给定任务，不接受模型发明或跨用户运行', async () => {
    const context = { baseline: {}, tasks: [{ id: 'owned' }], history: [], userMessageId: 11 };
    assert.throws(() => normalizeIntent({ ...modelDecision, action: 'continue_run', continuationOf: 'other-user-run' }, context));
    assert.equal(normalizeIntent({ ...modelDecision, action: 'continue_run', continuationOf: 'owned' }, context).continuationOf, 'owned');
    assert.equal(classifyChatAutoExecution({ prompt: '按刚才的方案修改，并跑测试', history: [{ role: 'user', content: '请分析项目代码' }] }).action, 'continue_run');
});

test('只规划硬限制不会被语义结果推翻；无效能力与响应失败给出明确阻断', async () => {
    const planned = await resolveChatIntent({ ...input, prompt: '先给出修复方案，不要改代码' }, deps(modelDecision));
    assert.equal(planned.action, 'plan_only');
    for (const output of [{ ...modelDecision, requiredCapabilities: ['admin.all'] }, {}, { ...modelDecision, action: 'execute_everything' }]) {
        const result = await resolveChatIntent(input, deps(output));
        assert.equal(result.action, 'clarify');
        assert.equal(result.reasonCode, 'intent_unavailable');
    }
});

test('影子与零比例灰度保留建议证据但不自动执行', async () => {
    const result = await resolveChatIntent(input, { ...deps(modelDecision), config: { ...config, mode: 'shadow' } });
    assert.equal(result.action, 'direct_answer');
    assert.equal(result.shadow, true);
    const zero = await resolveChatIntent(input, { ...deps(modelDecision), config: { ...config, rolloutPercent: 0 } });
    assert.equal(zero.action, 'direct_answer');
});

test('停止和遗忘不依赖自动执行许可；讨论停止功能不取消任务', () => {
    assert.equal(classifyChatAutoExecution({ prompt: '停止' }).action, 'control');
    assert.equal(classifyChatAutoExecution({ prompt: '暂停当前任务' }).control, 'pause');
    assert.equal(classifyChatAutoExecution({ prompt: '停止当前任务如何实现？' }).action, 'direct_answer');
    assert.equal(classifyChatAutoExecution({ prompt: '忘掉刚才那个偏好' }).action, 'memory');
    assert.equal(classifyChatAutoExecution({ prompt: '以后会出现什么趋势？' }).action, 'direct_answer');
});

test('委托能力约束必须覆盖工具的每项能力，审批也不能越过作用域', () => {
    const tool = { name: 'test.readwrite', source: 'builtin', capabilities: ['filesystem.read_workspace','filesystem.write_workspace'], input_schema: { type: 'object' } };
    const result = evaluateToolPolicy({ run: { metadata: { capabilityConstraints: { present: true, capabilities: ['filesystem.read_workspace'] } } }, tool, input: {}, allowApproval: true });
    assert.equal(result.decision, 'denied');
    assert.ok(result.reasonCodes.includes('conversation_capability_scope'));
});

test('自动任务缺少独立交付核验或真实产物不能被标记为已完成', async () => {
    const contract = { goal: '报告', deliverables: ['风险报告'], acceptance: { requireSemanticVerification: true, artifactRequired: true } };
    assert.equal(verifyTaskOutcome({ taskContract: contract, answer: '已经完成' }).outcomeStatus, 'needs_input');
    const evidence = await verifyAutomaticTask({ run: { id: 'r', model_id: 8 }, user: { id: 9 }, contract, answer: '已完成' }, { readyRunArtifacts: async () => [], getModel: async () => { throw new Error('未生成文件时不能进入模型自评'); } });
    assert.equal(evidence.reason, 'artifact_not_materialized');
    const failed = await verifyAutomaticTask({ run: { id: 'r' }, user: { id: 9 }, contract: { ...contract, acceptance: {} }, answer: '报告' }, { getModel: async () => ({}), callModelJson: async () => JSON.stringify({ passed: true, coveredDeliverables: [], missing: [] }) });
    assert.equal(failed.passed, false);
});

test('交付核验遗漏了未逐字覆盖的目标时返回具体缺项，供任务内部补全', async () => {
    const contract = { goal: '分析上传文件', deliverables: ['逐项总结文件中的部署检查清单'], acceptance: { requireSemanticVerification: true } };
    const result = await verifyAutomaticTask({ run: { id: 'r', model_id: 8 }, user: { id: 9 }, contract, answer: '已总结检查清单。' }, {
        getModel: async () => ({}),
        callModelJson: async () => JSON.stringify({ passed: true, coveredDeliverables: ['检查清单摘要'], missing: [] })
    });
    assert.equal(result.passed, false);
    assert.deepEqual(result.missing, ['逐项总结文件中的部署检查清单']);
});

test('独立后台审查只处理已知只读范围，强制人工、写入和策略拒绝均不可覆盖', async () => {
    const run = { user_id: 9, goal: '查询订单', metadata: { automaticExecution: {}, capabilityConstraints: { present: true, capabilities: ['data.sql.query'] } } };
    const tool = { name: 'db.run_readonly_query', source: 'mcp', databaseTool: true, risk: 'high', capabilities: ['data.sql.query'], idempotent: true, network: false, input_schema: { type: 'object' } };
    const base = { run, tool, input: {}, user: { id: 9 } };
    const options = { enabled: true, getModel: async () => ({}), callModelJson: async () => '{"withinScope":true,"readOnly":true}' };
    assert.equal((await reviewChatAction(base, options)).allowed, true);
    for (const denied of [
        { ...base, tool: { ...tool, side_effect: true } },
        { ...base, tool: { ...tool, alwaysRequiresApproval: true } },
        { ...base, run: { ...run, approval_policy: 'approve_all_mcp' } },
        { ...base, tool: { ...tool, capabilities: ['filesystem.write_workspace'] } }
    ]) assert.equal((await reviewChatAction(denied, options)).allowed, false);
    assert.equal((await reviewChatAction(base, { ...options, evaluateToolPolicy: () => ({ decision: 'denied' }) })).allowed, false);
    assert.equal((await reviewChatAction(base, { ...options, callModelJson: async () => { throw new Error('核验超时'); } })).allowed, false);
});

test('执行器必须接受最新策略拒绝，不能用内存旧快照覆盖撤销', async () => {
    let executed = false;
    const orchestrator = createToolOrchestrator({ recordAgentEvent: async () => {}, enforceToolPolicy: () => ({ decision: 'allow', input: {} }) });
    await assert.rejects(orchestrator.execute({ run: { id: 'stale' }, user: { id: 9 }, tool: { name: 'workspace.patch' }, input: {},
        executionPlan: { policy: { decision: 'denied', reasons: ['能力范围已撤回'] } }, execute: async () => { executed = true; } }), error => error.code === 'AGENT_POLICY_DENIED');
    assert.equal(executed, false);
});
