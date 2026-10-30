'use strict';

const { assert, test } = require('./security-helpers');
const { queryOne } = require('../server/db/client');
const { createChatFixture, postChat, readSessionMessages, startChatRouteServer, startFakeUpstream } = require('./security-chat/chat-route-harness');

test('上游空回复显示可重试错误并保留用户消息，不保存空的成功回复', async () => {
    let requests = 0;
    const upstream = await startFakeUpstream({ handler: (req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const input = JSON.parse(body || '{}');
            if (input.stream === false) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '普通对话' } }] }));
                return;
            }
            requests += 1;
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(requests === 1 ? 'data: [DONE]\n\n' : 'data: {"choices":[{"delta":{"content":"重试成功"}}]}\n\ndata: [DONE]\n\n');
        });
    } });
    const fixture = createChatFixture({ prefix: 'chat_empty_response', upstreamUrl: upstream.url });
    const routeServer = await startChatRouteServer({ fixture });
    try {
        const request = {
            sessionId: fixture.sessionId, content: '请解释这段内容', modelId: fixture.modelId,
            clientRequestId: 'empty-response-request-001', chatMode: 'normal', mcpEnabled: false, ragPreference: 'disabled', ragEnabled: false
        };
        const result = await postChat(routeServer.port, request);
        assert.equal(result.errorEvent?.code, 'MODEL_EMPTY_RESPONSE');
        assert.equal(result.errorEvent?.retryable, true);
        assert.equal(result.events.some(item => item.type === 'message_saved' && item.role === 'assistant'), false);
        const messages = readSessionMessages(fixture);
        assert.equal(messages.filter(item => item.role === 'user').length, 1);
        assert.ok(messages.some(item => item.role === 'assistant' && /空回复/.test(item.content)));
        const turn = await queryOne('SELECT status, outcome, assistant_message_id FROM chat_conversation_turns WHERE session_id = ? AND request_key = ?', [fixture.sessionId, request.clientRequestId]);
        assert.equal(turn.status, 'completed');
        assert.equal(turn.outcome.status, 'error');
        assert.ok(turn.assistant_message_id);
        const replay = await postChat(routeServer.port, request);
        assert.equal(replay.errorEvent?.code, 'MODEL_EMPTY_RESPONSE');
        assert.equal(requests, 1);
        const retry = await postChat(routeServer.port, {
            sessionId: fixture.sessionId, content: '请再次解释这段内容', modelId: fixture.modelId,
            chatMode: 'normal', mcpEnabled: false, ragPreference: 'disabled', ragEnabled: false
        });
        assert.equal(retry.streamedContent, '重试成功');
        assert.equal(retry.errorEvent, undefined);
        assert.equal(retry.findEvent(item => item.type === 'message_saved' && item.role === 'assistant')?.content, '重试成功');
    } finally {
        await routeServer.close();
        await upstream.close();
        fixture.cleanup();
    }
});

test('模型返回标准 429 时提示限流而不是笼统错误', async () => {
    const upstream = await startFakeUpstream({ handler: (_req, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Too Many Requests' } }));
    } });
    const fixture = createChatFixture({ prefix: 'chat_rate_limit', upstreamUrl: upstream.url });
    const routeServer = await startChatRouteServer({ fixture });
    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId, content: '请解释基础概念', modelId: fixture.modelId,
            chatMode: 'normal', mcpEnabled: false, ragPreference: 'disabled', ragEnabled: false
        });
        assert.equal(result.errorEvent?.code, 'RATE_LIMIT_EXCEEDED');
        assert.match(result.errorEvent?.error || '', /限流/);
    } finally {
        await routeServer.close();
        await upstream.close();
        fixture.cleanup();
    }
});

test('模型只返回 429 状态而没有详细错误时仍提示稍后重试', async () => {
    const upstream = await startFakeUpstream({ handler: (_req, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end('{}');
    } });
    const fixture = createChatFixture({ prefix: 'chat_rate_limit_empty', upstreamUrl: upstream.url });
    const routeServer = await startChatRouteServer({ fixture });
    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId, content: '请解释基础概念', modelId: fixture.modelId,
            chatMode: 'normal', mcpEnabled: false, ragPreference: 'disabled', ragEnabled: false
        });
        assert.equal(result.errorEvent?.code, 'RATE_LIMIT_EXCEEDED');
        assert.match(result.errorEvent?.detail || '', /稍候/);
    } finally {
        await routeServer.close();
        await upstream.close();
        fixture.cleanup();
    }
});
