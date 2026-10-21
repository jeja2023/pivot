'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatFixture, startFakeUpstream, startChatRouteServer, postChat, readSessionMessages } = require('./security-chat/chat-route-harness');

test('真实聊天路由的 Responses 增量、结束快照、落库和保存通知内容一致且不重复', async () => {
    const expected = '已完成核对，全部内容只返回一遍。';
    const paths = [];
    const upstream = await startFakeUpstream({ handler(req, res) {
        paths.push(req.url);
        if (!/\/responses$/.test(req.url)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '普通对话标题' } }] }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        const frames = [
            { type: 'response.output_text.delta', delta: '已完成核对，' },
            { type: 'response.output_text.delta', delta: '全部内容只返回一遍。' },
            { type: 'response.completed', response: { id: 'response-route', output: [
                { type: 'message', content: [{ type: 'output_text', text: expected }] }
            ], usage: { input_tokens: 8, output_tokens: 12, total_tokens: 20 } } }
        ];
        frames.forEach(frame => res.write(`data: ${JSON.stringify(frame)}\n\n`));
        res.end('data: [DONE]\n\n');
    } });
    let fixture;
    let server;
    try {
        fixture = createChatFixture({ prefix: 'gpt-5.6-stream-snapshot', upstreamUrl: upstream.url,
            modelColumns: { supports_reasoning: 1, chat_thinking_enabled: 0 } });
        server = await startChatRouteServer({ fixture });
        const result = await postChat(server.port, { sessionId: fixture.sessionId, content: '你好，请简要解释一次普通对话。', modelId: fixture.modelId, chatMode: 'normal', ragEnabled: false, mcpEnabled: false });
        assert.equal(result.errorEvent, undefined);
        assert.ok(paths.some(path => /\/responses$/.test(path)));
        assert.equal(result.streamedContent, expected);
        const saved = result.events.find(event => event.type === 'message_saved' && event.role === 'assistant');
        assert.equal(saved.content, expected);
        const messages = readSessionMessages(fixture).filter(row => row.role === 'assistant');
        assert.equal(messages.length, 1);
        assert.equal(messages[0].content, expected);
    } finally {
        await server?.close();
        await upstream.close();
        fixture?.cleanup();
    }
});
