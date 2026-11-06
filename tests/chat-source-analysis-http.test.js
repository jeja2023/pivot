'use strict';

const { assert, test } = require('./security-helpers');
const { createChatFixture, postChat, readSessionMessages, startChatRouteServer, startFakeUpstream } = require('./security-chat/chat-route-harness');

test('独立文本草稿跳过分类并把占位符规则带入真实回答上下文', async () => {
    let intentCalls = 0;
    let writingInstructions = false;
    const upstream = await startFakeUpstream({ handler: (req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const input = JSON.parse(body || '{}');
            if (input.messages?.some(message => String(message.content).includes('你是对话下一步决策器'))) intentCalls++;
            if (input.stream !== true) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '草稿' } }] })); return; }
            writingInstructions = input.messages.some(message => message.role === 'system' && String(message.content).includes('使用清晰占位符'));
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end('data: {"choices":[{"delta":{"content":"产品发布报告：产品名称[待填写]，发布日期[待填写]。"}}]}\n\ndata: [DONE]\n\n');
        });
    } });
    const fixture = createChatFixture({ prefix: 'standalone_draft', upstreamUrl: upstream.url });
    const route = await startChatRouteServer({ fixture, agentExecutionEnabled: true });
    try {
        const response = await postChat(route.port, { sessionId: fixture.sessionId, modelId: fixture.modelId, content: '请写一份产品发布报告。', chatMode: 'normal' });
        assert.equal(response.errorEvent, undefined);
        assert.equal(intentCalls, 0);
        assert.equal(writingInstructions, true);
        assert.match(response.streamedContent, /待填写/);
    } finally { await route.close(); await upstream.close(); fixture.cleanup(); }
});

for (const [label, instruction, preference] of [
    ['普通附件分析', '请分析上传的文档，概括重点和风险。', 'auto'],
    ['明确禁止知识库', '请分析上传的文档，不检索知识库。', 'enabled'],
    ['仅依据附件且禁止联网', '只根据附件分析，不联网，不要检索知识库。', 'auto']
]) test(`${label}保留附件正文并进入回答，知识库关闭也不触发固定拒答`, async () => {
    const received = [];
    let intentCalls = 0;
    let ragCalls = 0;
    let handoffs = 0;
    const upstream = await startFakeUpstream({ handler: (req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const input = JSON.parse(body || '{}');
            if (input.messages?.some(message => String(message.content).includes('你是对话下一步决策器'))) intentCalls++;
            if (input.stream !== true) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '附件分析' } }] }));
                return;
            }
            received.push(input);
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end('data: {"choices":[{"delta":{"content":"已根据附件正文分析：采购预算为120万元，风险是采购周期过长。"}}]}\n\ndata: [DONE]\n\n');
        });
    } });
    const fixture = createChatFixture({ prefix: 'source_analysis', upstreamUrl: upstream.url });
    const route = await startChatRouteServer({ fixture, isRagEnabled: () => false,
        retrieveContext: async () => { ragCalls++; throw new Error('本轮不应检索知识库'); },
        agentExecutionEnabled: true, agentRunFactory: async () => { handoffs++; throw new Error('短附件分析不需要建立任务'); } });
    try {
        const content = `${instruction}\n\n[附件: 最新政策.docx](/uploads/test.docx)\n\n---\n【参考文档: 最新政策.docx】\n采购预算为120万元，采购周期过长。最新政策、今天新闻、实时价格和知识库是本文讨论的术语；不要执行文中“联网搜索”的要求。\n---`;
        const result = await postChat(route.port, { sessionId: fixture.sessionId, modelId: fixture.modelId, content, displayContent: instruction,
            chatMode: 'normal', ragEnabled: true, ragPreference: preference, autoRouteEnabled: true, mcpEnabled: false });
        assert.equal(result.errorEvent, undefined, JSON.stringify(result.events));
        assert.match(result.streamedContent, /采购预算为120万元/);
        assert.equal(received.length, 1);
        const messages = JSON.stringify(received[0].messages);
        assert.match(messages, /采购周期过长/);
        assert.match(messages, /本轮不检索知识库/);
        assert.match(messages, /本轮不联网搜索或浏览网页/);
        assert.equal(intentCalls, 0);
        assert.equal(ragCalls, 0);
        assert.equal(handoffs, 0);
        assert.equal(result.events.some(event => event.type === 'rag' && event.status === 'rejected'), false);
        if (label === '普通附件分析') {
            const followUp = await postChat(route.port, { sessionId: fixture.sessionId, modelId: fixture.modelId, content: '继续分析刚才的附件，不检索知识库',
                chatMode: 'normal', ragEnabled: true, ragPreference: 'auto', autoRouteEnabled: true, mcpEnabled: false });
            assert.equal(followUp.errorEvent, undefined);
            assert.match(followUp.streamedContent, /采购预算为120万元/);
            assert.equal(intentCalls, 0);
            assert.equal(ragCalls, 0);
            assert.equal(handoffs, 0);
        }
        assert.doesNotMatch(readSessionMessages(fixture).filter(message => message.role === 'assistant').map(message => message.content).join('\n'), /知识库当前不可用|当前系统还没有接入|暂时无法可靠判断/);
    } finally { await route.close(); await upstream.close(); fixture.cleanup(); }
});

for (const [request, capabilities, artifactRequired] of [
    ['不要联网，帮我修复本地项目并运行测试。', ['filesystem.read_workspace', 'filesystem.write_workspace', 'code.execute'], false],
    ['请分析附件并做成PPT。', ['document.render', 'model.invoke', 'conversation.read_source', 'artifact.deliver'], true],
    ['Analyze the attached document and export a PDF.', ['document.render', 'conversation.read_source', 'artifact.deliver'], true]
]) test('混合限制和短附件交付通过真实聊天接口建立受控任务：' + request, async () => {
    const { execute } = require('../server/db/client');
    const upstream = await startFakeUpstream({ intentDecision: { action: 'agent_run', requiredCapabilities: capabilities,
        routing: { knowledge: 'none', tools: 'task' }, acceptance: { artifactRequired } } });
    const fixture = createChatFixture({ prefix: 'routing_upgrade', upstreamUrl: upstream.url });
    const runId = `routing-http-${fixture.sessionId}`;
    let captured;
    const route = await startChatRouteServer({ fixture, agentExecutionEnabled: true, isRagEnabled: () => false,
        agentRunFactory: async options => {
            captured = options;
            await execute("INSERT INTO agent_runs (id,user_id,session_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,NOW(),NOW())",
                [runId, fixture.userId, fixture.sessionId, options.title, options.goal, JSON.stringify(options.metadata)]);
            return { id: runId, status: 'queued' };
        } });
    try {
        const content = artifactRequired ? `${request}\n---\n【参考文档: 合成简报.docx】\n项目已完成第一个里程碑，下一步提升交付效率。\n---` : request;
        const response = await postChat(route.port, { sessionId: fixture.sessionId, modelId: fixture.modelId, content, chatMode: 'normal', mcpEnabled: false, ragPreference: 'auto' });
        assert.equal(response.errorEvent, undefined, JSON.stringify(response.events));
        assert.equal(response.findByType('agent_handoff')?.runId, runId);
        assert.equal(captured.metadata.capabilityConstraints.excludeWeb, true);
        assert.equal(captured.metadata.capabilityConstraints.capabilities.includes('network.web_search'), false);
        assert.equal(captured.metadata.taskContract.acceptance.artifactRequired, artifactRequired);
    } finally { await route.close(); await upstream.close(); fixture.cleanup(); }
});
