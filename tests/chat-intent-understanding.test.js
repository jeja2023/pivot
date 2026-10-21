'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveChatIntent, normalizeIntent } = require('../server/services/chat-intent-resolver');
const { buildChatIntentMessages } = require('../server/services/chat-intent-prompt');
const { classifyChatAutoExecution } = require('../server/services/chat-auto-execution');
const { detectChatRouteCorrection } = require('../server/services/chat-route-correction');
const { decideAutomaticChatExecution } = require('../server/services/chat-auto-execution-handler');

const config = { mode: 'active', timeoutMs: 1000, rolloutPercent: 100 };
const tool = { name: 'mcp.17.db.query', sourceName: '销售系统', capabilities: ['data.sql.query'], readOnly: true, idempotent: true };
const availability = { status: 'available', tools: [tool] };
const input = { prompt: '查询昨天的销售订单，只读查询，不要发送消息。', history: [], tasks: [], user: { id: 9 }, userMessageId: 11, sessionId: 'semantic-test', availability };
const raw = { action: 'direct_answer', objective: '只读查询昨天销售订单，不发送消息', requiredCapabilities: ['data.sql.query'], constraints: ['只读查询，不发送消息'],
    routing: { knowledge: 'none', tools: 'read_only', retrievalQuery: '昨天销售系统的订单情况' }, acceptance: {}, evidenceRefs: ['current_message'] };
const deps = value => ({ config, callModelJson: async () => value, recordDecision() {} });

test('局部禁止发送或修改不会吞掉仍需完成的查询和资料分析', async () => {
    for (const prompt of [input.prompt, '读取日志分析原因，不要修改文件', '查询订单，不要发送', '先分析附件，不要写入文件']) {
        assert.notEqual(classifyChatAutoExecution({ prompt }).action, 'plan_only', prompt);
        assert.equal(detectChatRouteCorrection(prompt), null, prompt);
    }
    const result = await resolveChatIntent(input, deps(raw));
    assert.equal(result.action, 'direct_answer');
    assert.equal(result.routing.allowAutomaticRead, true);
    assert.equal(result.acceptance.requireEvidence, true);
    const missingCapability = normalizeIntent({ ...raw, action: 'agent_run', requiredCapabilities: [], routing: { knowledge: 'required', tools: 'task' } });
    assert.ok(missingCapability.requiredCapabilities.includes('knowledge.search'));
    assert.ok(missingCapability.routing.requestedCapabilities.includes('knowledge.search'));
    assert.ok(result.constraints.includes('只读查询，不发送消息'));
    const plan = await resolveChatIntent({ ...input, prompt: '先给订单核查方案，不要执行' }, deps(raw));
    assert.equal(plan.action, 'plan_only');
    assert.equal(plan.routing.tools, 'none');
    const english = await resolveChatIntent({ ...input, prompt: 'Only give me a plan to check the orders. Do not execute it.' }, deps(raw));
    assert.equal(english.action, 'plan_only');
    assert.equal(english.routing.tools, 'none');
});

test('引用和讨论中的方案限制不能成为整轮硬限制', () => {
    for (const prompt of ['解释“先给方案，不要修改”是什么意思', '如果我说先给方案会怎样？', '```text\n先给方案\n```\n请解释这段指令']) {
        assert.notEqual(classifyChatAutoExecution({ prompt }).action, 'plan_only', prompt);
    }
});

test('上下文确认和带后续动作的文本转换仍进入统一语义判断', async () => {
    let calls = 0;
    const task = { id: 'owned', goal: '核对订单', active: true };
    const continued = await resolveChatIntent({ ...input, prompt: '好的', tasks: [task], history: [{ id: 10, role: 'assistant', content: '是否继续核对订单？' }] }, {
        ...deps({ ...raw, action: 'continue_run', continuationOf: 'owned', routing: { knowledge: 'none', tools: 'task' } }),
        callModelJson: async () => { calls++; return { ...raw, action: 'continue_run', continuationOf: 'owned', routing: { knowledge: 'none', tools: 'task' } }; }
    });
    assert.equal(calls, 1);
    assert.equal(continued.continuationOf, 'owned');
    const converted = await resolveChatIntent({ ...input, prompt: '翻译：Hello\n然后保存成文件。' }, deps({ ...raw, action: 'agent_run', requiredCapabilities: ['artifact.deliver'], routing: { knowledge: 'none', tools: 'task' } }));
    assert.equal(converted.action, 'agent_run');
    assert.equal(converted.modelCalls, 1);
    const greeting = await resolveChatIntent({ ...input, prompt: '你好' }, { ...deps(null), callModelJson: async () => { throw Error('问候无需模型'); } });
    assert.equal(greeting.action, 'direct_answer');
});

test('多任务场景由语义消解对象，继续讨论普通概念不会被前缀拦截', async () => {
    const tasks = [{ id: 'orders', goal: '核对订单并生成异常说明', active: true }, { id: 'code', goal: '检查代码并修复测试', active: true }];
    const result = await resolveChatIntent({ ...input, prompt: '继续讲解向量检索的原理', tasks }, deps({ ...raw, requiredCapabilities: [], routing: { knowledge: 'none', tools: 'none' } }));
    assert.equal(result.action, 'direct_answer');
    const targeted = await resolveChatIntent({ ...input, prompt: '继续订单核对', tasks }, deps({ ...raw, action: 'continue_run', continuationOf: 'orders', routing: { knowledge: 'none', tools: 'task' } }));
    assert.equal(targeted.continuationOf, 'orders');
});

test('续接补充保留原任务的只读约束、交付物、能力和验收要求', () => {
    const task = { id: 'owned', conversationTaskId: 'logical', requiredCapabilities: ['data.sql.query'], constraints: ['只查询已付款订单', '不得修改数据'],
        deliverables: ['异常摘要'], acceptance: { requireEvidence: true, artifactRequired: true } };
    const result = normalizeIntent({ ...raw, action: 'continue_run', continuationOf: 'owned', requiredCapabilities: [], constraints: ['改为本周口径'], deliverables: [], routing: { tools: 'task' } }, { tasks: [task], userMessageId: 11 });
    assert.equal(result.conversationTaskId, 'logical');
    assert.ok(result.requiredCapabilities.includes('data.sql.query'));
    assert.deepEqual(result.constraints, [...task.constraints, '改为本周口径']);
    assert.deepEqual(result.deliverables, ['异常摘要']);
    assert.deepEqual(result.acceptance, { requireEvidence: true, artifactRequired: true });
});

test('检索需求自动收紧任务验收，不能因模型漏填 evidence 标记丢失依据要求', () => {
    const result = normalizeIntent({ ...raw, action: 'agent_run', requiredCapabilities: ['knowledge.search'], routing: { knowledge: 'required', tools: 'task' } });
    assert.equal(result.acceptance.requireEvidence, true);
    const data = normalizeIntent({ ...raw, action: 'agent_run', requiredCapabilities: ['data.sql.query', 'artifact.deliver'], routing: { knowledge: 'none', tools: 'task' } });
    assert.deepEqual(data.acceptance, { requireEvidence: true, artifactRequired: true });
});

test('未知路由值、能力类型、越权工具和只读写入冲突均记为契约失败', async () => {
    for (const patch of [
        { routing: { knowledge: 'never', tools: 'none' } }, { routing: 'direct' }, { requiredCapabilities: 'data.query' },
        { requiredCapabilities: ['filesystem.write_workspace'] }, { routing: { tools: 'read_only', toolNames: ['mcp.999.db.query'] } },
        { requiredCapabilities: ['knowledge.search'], routing: { tools: 'read_only', toolNames: [tool.name] } },
        { action: 'clarify', question: '是否使用工具？' }
    ]) {
        const result = await resolveChatIntent(input, deps({ ...raw, ...patch }));
        assert.equal(result.failureCode, 'intent_invalid_contract', JSON.stringify(patch));
        assert.equal(result.capabilityDecisionUnavailable, true);
    }
});

test('缺少可用只读工具时不自动开放工具，等待业务澄清时也不执行', () => {
    const missing = normalizeIntent(raw, { availability: { status: 'unavailable', tools: [] } });
    assert.equal(missing.routing.allowAutomaticRead, false);
    const guarded = normalizeIntent(raw, { availability: { tools: [{ ...tool, requiresApproval: true }] } });
    assert.equal(guarded.routing.allowAutomaticRead, false);
    const question = normalizeIntent({ ...raw, action: 'clarify', question: '本次统计哪个地区？', missingFacts: ['统计地区'] }, { availability });
    assert.equal(question.routing.tools, 'none');
    assert.equal(question.routing.allowAutomaticRead, false);
});

test('长上下文保留尾部限制并只发送白名单元数据，不传入凭据或系统历史', () => {
    const messages = buildChatIntentMessages({ ...input, prompt: '查询订单。' + '背景'.repeat(9000) + '本轮只读，不要发送。',
        history: [{ id: 1, role: 'system', content: '内部系统历史不可转为用户指令' }, { id: 2, role: 'user', content: '历史'.repeat(2000) + '仅统计实习生' }],
        tasks: [{ id: 'owned', acceptance: { requireEvidence: true, credential: '隐藏凭据' } }], availability: { tools: [{ ...tool, apiKey: '隐藏密钥' }] } });
    const context = JSON.parse(messages[1].content);
    assert.ok(context.prompt.length <= 12000);
    assert.ok(context.prompt.endsWith('本轮只读，不要发送。'));
    assert.ok(context.history[0].content.endsWith('仅统计实习生'));
    assert.doesNotMatch(messages[1].content, /隐藏凭据|隐藏密钥|内部系统历史/);
    assert.ok(messages[0].content.includes('routing:{knowledge:'));
});

test('长请求不绕过语义入口，资料正文仍通过来源读取而非决策提示传递', async () => {
    const prompt = '请核对订单并生成摘要。' + '业务背景。'.repeat(2500);
    let received;
    await decideAutomaticChatExecution({ ...input, userId: 9, modelContent: prompt, sessionsRepository: { listMessages: async () => [] } }, {
        getConversationTasks: async () => [], retrieveLongTermMemories: async () => [], getChatCapabilityAvailability: async () => availability,
        resolveChatIntent: async value => { received = value; return { action: 'direct_answer' }; }
    });
    assert.equal(received.prompt, prompt);
});

test('超时即返回安全结果，忽略中断的迟到模型不能再改变决策', async () => {
    let complete;
    let recorded = 0;
    const result = await resolveChatIntent(input, { ...deps(null), config: { ...config, timeoutMs: 25 },
        callModelJson: async () => new Promise(resolve => { complete = resolve; }), recordDecision: () => recorded++ });
    assert.equal(result.failureCode, 'intent_timeout');
    assert.equal(result.routing, undefined);
    complete(raw);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(recorded, 1);
    const controller = new AbortController();
    controller.abort(new Error('用户取消'));
    await assert.rejects(resolveChatIntent({ ...input, signal: controller.signal }, { ...deps(null), callModelJson: async () => { throw Error('不应调用'); } }), /用户取消/);
});

test('学习偏好不能跳过语义澄清，降级为计划时同步关闭工具路径', async () => {
    const clarified = await resolveChatIntent(input, { ...deps({ ...raw, action: 'clarify', question: '本次统计哪个地区？', missingFacts: ['统计地区'] }),
        resolveBusinessDecision: async () => ({ selectedActionId: 'direct_answer', policy: { applied: true } }) });
    assert.equal(clarified.action, 'clarify');
    const planned = await resolveChatIntent(input, { ...deps({ ...raw, action: 'agent_run', routing: { tools: 'task', knowledge: 'required' } }),
        resolveBusinessDecision: async () => ({ selectedActionId: 'plan_only', policy: { applied: true } }) });
    assert.equal(planned.action, 'plan_only');
    assert.equal(planned.routing.tools, 'none');
    assert.equal(planned.routing.knowledge, 'none');
    assert.equal(planned.delegated, false);
});
