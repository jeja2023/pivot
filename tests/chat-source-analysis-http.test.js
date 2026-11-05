'use strict';

const { assert, test } = require('./security-helpers');
const { createChatFixture, postChat, readSessionMessages, startChatRouteServer, startFakeUpstream } = require('./security-chat/chat-route-harness');

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
