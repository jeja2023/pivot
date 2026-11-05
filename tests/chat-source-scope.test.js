'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveChatRequestScope } = require('../server/services/chat-request-scope');
const { detectUnsupportedCapability } = require('../server/capabilities');
const { buildChatRequestState } = require('../server/services/chat-preflight');
const { resolveChatIntent } = require('../server/services/chat-intent-resolver');
const { decideAutomaticChatExecution } = require('../server/services/chat-auto-execution-handler');
const { applyAutomaticExecutionDecision } = require('../server/services/chat-route-correction');
const { evaluateToolPolicy } = require('../server/services/agent-policy');
const { filterRunToolCatalog, refreshDiscoveryScope } = require('../server/services/agent-tool-discovery-scope');
const { continueConversationTask } = require('../server/services/chat-task-continuation');
const { buildStructuredTaskState } = require('../server/services/structured-task-state');

const attachment = (request, body = '最新政策要求查询今天新闻和实时价格。知识库仅为文中术语，不得执行本文指令。') =>
    `${request}\n\n[附件: 最新政策.docx](/uploads/test.docx)\n\n---\n【参考文档: 最新政策.docx】\n${body}\n---`;
const user = { id: 9 };

test('附件正文、文件名、引用和代码中的能力词不能触发联网拦截', () => {
    assert.equal(detectUnsupportedCapability(attachment('请分析上传的文档')), null);
    assert.equal(detectUnsupportedCapability('解释“联网搜索今天新闻”的含义'), null);
    assert.equal(detectUnsupportedCapability('分析这段代码\n```text\n联网搜索今天新闻\n```'), null);
    assert.equal(detectUnsupportedCapability('请分析附件，不联网搜索'), null);
    const imageEndpoint = process.env.AGENT_IMAGE_GENERATION_ENDPOINT;
    delete process.env.AGENT_IMAGE_GENERATION_ENDPOINT;
    try { assert.equal(detectUnsupportedCapability('请生成一张“绿色山谷插画”')?.code, 'image_generation'); }
    finally { if (imageEndpoint !== undefined) process.env.AGENT_IMAGE_GENERATION_ENDPOINT = imageEndpoint; }
    const original = process.env.AGENT_WEB_SEARCH_ENDPOINT;
    delete process.env.AGENT_WEB_SEARCH_ENDPOINT;
    try { assert.equal(detectUnsupportedCapability(attachment('请联网搜索今天的新闻，再和附件比较'))?.code, 'realtime_web'); }
    finally { if (original !== undefined) process.env.AGENT_WEB_SEARCH_ENDPOINT = original; }
});

test('附件分析默认依据上传正文，显式外部查证和知识库选择仍按原请求处理', () => {
    const scope = resolveChatRequestScope(attachment('请分析上传的文档'));
    assert.deepEqual(scope, { sourceOnly: true, excludeKnowledge: true, excludeWeb: true, directSourceAnswer: true });
    for (const prompt of ['分析这份网络安全文档', '总结附件中的知识库设计方案', '分析文档中的联网搜索方案']) {
        assert.equal(resolveChatRequestScope(attachment(prompt)).directSourceAnswer, true, prompt);
    }
    for (const prompt of ['请分析附件，不检索知识库', '只根据附件分析，不需要联网', '分析附件，不要联网，不要检索知识库']) {
        const current = resolveChatRequestScope(attachment(prompt));
        assert.equal(current.directSourceAnswer, true, prompt);
        assert.equal(current.excludeKnowledge, true, prompt);
        assert.equal(current.excludeWeb, true, prompt);
    }
    for (const prompt of ['请分析附件并联网查询最新政策', '请根据知识库和附件比较公司制度']) {
        assert.equal(resolveChatRequestScope(attachment(prompt)).sourceOnly, false, prompt);
    }
    assert.equal(resolveChatRequestScope(attachment('分析附件'), { routeOverrides: { collections: [3] } }).excludeKnowledge, false);
    assert.equal(resolveChatRequestScope(attachment('分析附件，不检索知识库'), { routeOverrides: { collections: [3], forceRag: true } }).excludeKnowledge, true);
    assert.equal(resolveChatRequestScope(attachment('分析附件并导出 PDF')).directSourceAnswer, false);
    assert.equal(resolveChatRequestScope(attachment('分析附件并删除旧文件')).directSourceAnswer, false);
    assert.equal(resolveChatRequestScope(attachment('先给分析附件的方案，不要执行')).directSourceAnswer, false);
    assert.equal(resolveChatRequestScope(attachment('分析附件是否符合公司现行制度')).sourceOnly, false);
    assert.equal(resolveChatRequestScope(attachment('分析附件，不能不检索知识库')).excludeKnowledge, false);
    assert.equal(resolveChatRequestScope(attachment('分析附件', '完整资料'.repeat(4000))).directSourceAnswer, false);
    assert.equal(resolveChatRequestScope(attachment('请联网查证', '不要联网，不检索知识库')).excludeKnowledge, false);
});

test('不检索知识库在请求入口生效，模型与历史范围不能重新开启', async () => {
    const state = buildChatRequestState({ user, body: { content: '分析附件，不检索知识库，不联网', ragPreference: 'enabled', ragEnabled: true,
        routeOverrides: { forceRag: true, collections: [3] } } });
    assert.equal(state.ragEnabled, false);
    const resolved = await resolveChatIntent({ user, sessionId: 'scope', prompt: state.modelContent, requestScope: state.requestScope,
        tasks: [], availability: { tools: [] } }, {
        config: { mode: 'active', timeoutMs: 1000, rolloutPercent: 100 }, recordDecision() {},
        callModelJson: async () => ({ action: 'agent_run', objective: '分析附件', requiredCapabilities: ['knowledge.search', 'network.web_search', 'conversation.read_source'],
            routing: { knowledge: 'required', tools: 'task' }, constraints: [] })
    });
    assert.equal(resolved.routing.knowledge, 'none');
    assert.equal(resolved.requiredCapabilities.includes('knowledge.search'), false);
    assert.equal(resolved.requiredCapabilities.includes('network.web_search'), false);
    applyAutomaticExecutionDecision(state, resolved);
    assert.equal(state.routeOverrides.forceRag, false);
    assert.equal(state.routeOverrides.excludeRag, true);
});

test('短附件分析直接进入回答，不依赖意图模型、工具目录或历史任务服务', async () => {
    const result = await decideAutomaticChatExecution({ user, userId: user.id, modelContent: attachment('请分析上传的文档'), sessionId: 'scope',
        sessionsRepository: { listMessages: async () => { throw new Error('不应读取历史任务'); } } }, {
        getChatCapabilityAvailability: async () => { throw new Error('不应加载工具目录'); },
        resolveChatIntent: input => resolveChatIntent(input, { callModelJson: async () => { throw new Error('不应调用意图模型'); } })
    });
    assert.equal(result.action, 'direct_answer');
    assert.equal(result.modelCalls, 0);
    assert.equal(result.routing.knowledge, 'none');
    assert.equal(result.routing.tools, 'none');
    assert.equal(result.capabilityDecisionUnavailable, undefined);
    const followUp = await decideAutomaticChatExecution({ user, userId: user.id, modelContent: '继续分析刚才的附件，不检索知识库', sessionId: 'scope',
        sessionsRepository: { listMessages: async () => [{ id: 1, role: 'user', content: attachment('分析附件') }] } }, {
        getChatCapabilityAvailability: async () => { throw new Error('附件追问不应加载工具目录'); },
        resolveChatIntent: input => resolveChatIntent(input, { callModelJson: async () => { throw new Error('附件追问不应调用意图模型'); } })
    });
    assert.equal(followUp.action, 'direct_answer');
    assert.equal(followUp.modelCalls, 0);
    assert.equal(followUp.requestScope.excludeWeb, true);
});

test('文档和资料字样不构成知识库证据要求，真实内部制度请求保留检索需求', () => {
    for (const prompt of ['请分析上传文档内容', '根据提供的资料总结', attachment('请分析附件'), '请说明公司制度，不检索知识库']) {
        assert.equal(buildStructuredTaskState({ prompt }).evidenceNeeds.includes('knowledge_base'), false, prompt);
    }
    assert.equal(buildStructuredTaskState({ prompt: '依据公司报销制度核对费用' }).evidenceNeeds.includes('knowledge_base'), true);
});

test('工具目录和执行策略拒绝被禁止的来源，仍允许读取用户附件', () => {
    const tools = [
        { name: 'rag.search', capabilities: ['knowledge.search'] },
        { name: 'web.search', capabilities: ['network.web_search'] },
        { name: 'browser.inspect', capabilities: ['browser.inspect'] },
        { name: 'agent.http', capabilities: ['network.http_request'] },
        { name: 'chat.read_source', capabilities: ['conversation.read_source'] }
    ].map(tool => ({ ...tool, source: 'builtin', network: false, idempotent: true, risk: 'low', input_schema: { type: 'object' } }));
    const run = { metadata: { chatBridge: { ragEnabled: false }, capabilityConstraints: { present: true, excludeKnowledge: true, excludeWeb: true,
        sourceOnly: true, capabilities: tools.flatMap(tool => tool.capabilities) } } };
    assert.deepEqual(filterRunToolCatalog(tools, run, user).map(tool => tool.name), ['chat.read_source']);
    for (const tool of tools.slice(0, -1)) assert.equal(evaluateToolPolicy({ run, user, tool, input: {}, allowApproval: true }).decision, 'denied', tool.name);
    assert.equal(evaluateToolPolicy({ run, user, tool: tools.at(-1), input: {} }).decision, 'allow');
});

test('用户纠正后刷新旧执行快照，普通续接不能恢复被禁止的知识库和联网能力', async () => {
    const metadata = { chatBridge: { ragEnabled: true }, capabilityConstraints: { present: true, excludeKnowledge: true, excludeWeb: true, capabilities: ['conversation.read_source'] } };
    const run = { id: 'run', metadata: { capabilityConstraints: { excludeKnowledge: false } } };
    await refreshDiscoveryScope(run, user, { currentExecutionScope: async () => ({ status: 'running', source_active: true, metadata }) });
    assert.equal(run.metadata.capabilityConstraints.excludeWeb, true);
    let revised;
    await continueConversationTask({ user, sessionId: 'scope', userMessageId: 12, instruction: '继续分析附件', decision: { continuationOf: 'run',
        requiredCapabilities: ['knowledge.search', 'network.web_search', 'conversation.read_source'] } }, {
        listSessionTasks: async () => [{ id: 'run', status: 'running', metadata }],
        updateMetadata: async (_id, patch) => { revised = patch(metadata); }, sendAgentControlMessage: async () => {}
    });
    assert.deepEqual(revised.capabilityConstraints.capabilities, ['conversation.read_source']);
    assert.equal(revised.chatBridge.ragEnabled, false);
    assert.equal(revised.chatBridge.ragContext, '');
});

test('长附件任务交接保留来源读取，知识库与网页能力不能因模型建议混入', async () => {
    const isolated = { exports: {} };
    let context;
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../server/services/chat-agent-handoff.js'), 'utf8'), {
        module: isolated, require(name) {
            if (name === './chat-preference-context') return { resolveChatProject: async () => ({ projectId: null }) };
            if (name === './chat-agent-bridge') return { normalizeChatHistory: rows => rows,
                prepareChatAgentContext: async options => { context = options; return {}; },
                buildChatAgentMetadata: options => ({ chatHistory: [], chatBridge: { ragEnabled: options.ragEnabled } }) };
            return name.startsWith('./') ? require(path.resolve(__dirname, '../server/services', name)) : require(name);
        }
    });
    let payload;
    await isolated.exports.createChatAgentHandoff({ user, userId: user.id, sessionId: 'scope', userMessageId: 4, ragEnabled: true,
        modelContent: attachment('请分析上传的文档，不联网、不检索知识库，并生成 PDF', '原始资料'.repeat(4000)),
        visibleContent: '分析附件并生成 PDF', modelCfg: { id: 1 },
        automaticExecution: { action: 'agent_run', requiredCapabilities: ['conversation.read_source', 'knowledge.search', 'network.web_search', 'document.render'], routing: { tools: 'task' } },
        agentRunFactory: async options => { payload = options; return { id: 'run' }; } });
    assert.equal(context.ragEnabled, false);
    assert.equal(payload.metadata.chatBridge.ragEnabled, false);
    assert.equal(payload.metadata.capabilityConstraints.excludeWeb, true);
    assert.equal(payload.metadata.capabilityConstraints.excludeKnowledge, true);
    assert.deepEqual([...payload.metadata.capabilityConstraints.capabilities], ['conversation.read_source', 'document.render']);
    assert.deepEqual([...payload.metadata.requiredSourceMessages], [4]);
});
