'use strict';

const http = require('node:http');
const express = require('express');
const { assert, test, createOpenAIRouter } = require('./security-helpers');
const { createChatFixture, postChat, readSessionMessages, startChatRouteServer, startFakeUpstream } = require('./security-chat/chat-route-harness');
const { buildCapabilityContext } = require('../server/capabilities');
const { SVG_GENERATION_GUIDANCE } = require('../server/services/svg-generation-guidance');

const svgAnswer = '```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect x="85" y="70" width="30" height="45" fill="brown"/><circle cx="100" cy="45" r="40" fill="green"/></svg>\n```';

function reply(res, content, stream) {
    res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
    res.end(stream ? `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`
        : JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
}

test('能力上下文复用执行器可用性判定，配置地址和密钥不进入提示词', () => {
    assert.match(buildCapabilityContext({}), /未配置的 Pivot 内置执行接口：网页检索、图片生成、语音合成/);
    const configured = buildCapabilityContext({ AGENT_WEB_SEARCH_ENDPOINT: 'https://secret.example/search',
        AGENT_IMAGE_GENERATION_ENDPOINT: 'https://secret.example/image', PIVOT_TTS_ENDPOINT: 'https://secret.example/speech', AGENT_TTS_API_KEY: 'secret-key' });
    assert.doesNotMatch(configured, /未配置的 Pivot 内置执行接口|secret/);
});

test('文字、引用、代码和附件能力词仍进入正常回答，保留提示词及资料', async () => {
    const requests = [
        '请解释“生成一张图片”的含义，不要实际绘图。',
        '请翻译：text to video。',
        '比较 AI 绘画和传统插画的优缺点。',
        '请分析这段代码\n```text\ngenerate an image\ntext to speech\n```',
        '请概括下文的主题：最新新闻与实时价格如何影响市场。',
        '请分析附件\n\n[附件: 文生图与生成视频.docx](/uploads/example.docx)\n\n---\n【参考文档: 文生图与生成视频.docx】\n第一章：生成图片、制作视频、合成语音和联网搜索今天新闻的技术演进。\n---'
    ];
    const received = [];
    const answer = '已按本轮要求完成文字分析。';
    const upstream = await startFakeUpstream({ handler: (req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const input = JSON.parse(body);
            if (input.messages.some(message => String(message.content).includes('你是对话下一步决策器'))) {
                const context = JSON.parse(input.messages.find(message => message.role === 'user').content);
                reply(res, JSON.stringify({ action: 'direct_answer', objective: context.prompt, requiredCapabilities: [], routing: { knowledge: 'none', tools: 'none' } }), false);
            } else {
                if (input.stream === true) received.push(input);
                reply(res, answer, input.stream);
            }
        });
    } });
    try {
        for (const content of requests) {
            const fixture = createChatFixture({ prefix: 'capability_text', upstreamUrl: upstream.url });
            const route = await startChatRouteServer({ fixture, agentExecutionEnabled: true, isRagEnabled: () => false });
            try {
                const before = received.length;
                const result = await postChat(route.port, { sessionId: fixture.sessionId, modelId: fixture.modelId, content, mcpEnabled: false, ragPreference: 'disabled' });
                assert.equal(result.errorEvent, undefined, JSON.stringify(result.events));
                assert.equal(result.events.some(event => event.unsupportedCapability), false, content);
                assert.equal(result.streamedContent, answer, content);
                assert.equal(received.length, before + 1, content);
                const messages = received.at(-1).messages;
                const requestText = content.includes('【参考文档:') ? content.split('\n')[0] : content;
                const userText = messages.filter(message => message.role === 'user').map(message => Array.isArray(message.content)
                    ? message.content.map(part => part.text || '').join('') : message.content).join('\n');
                assert.ok(userText.includes(requestText), content);
                if (content.includes('【参考文档:')) assert.ok(userText.includes('第一章：生成图片、制作视频、合成语音和联网搜索今天新闻的技术演进。'));
                assert.ok(messages.some(message => message.role === 'system' && String(message.content).includes('不因提及某种能力而整轮拒答')));
                assert.equal(readSessionMessages(fixture).find(message => message.role === 'assistant')?.content, answer);
            } finally { await route.close(); fixture.cleanup(); }
        }
    } finally { await upstream.close(); }
});

test('未配置生图服务且历史曾拒绝时，SVG 图片请求仍按矢量源码进入路由和回答', async () => {
    const { saveAssistantMessage } = require('../server/services/chat-messages');
    const originalEndpoint = process.env.AGENT_IMAGE_GENERATION_ENDPOINT;
    delete process.env.AGENT_IMAGE_GENERATION_ENDPOINT;
    const received = { intent: [], answer: [] };
    const upstream = await startFakeUpstream({ handler: (req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const input = JSON.parse(body);
            if (input.messages.some(message => String(message.content).includes('你是对话下一步决策器'))) {
                received.intent.push(input);
                const context = JSON.parse(input.messages.find(message => message.role === 'user').content);
                reply(res, JSON.stringify({ action: 'direct_answer', objective: context.prompt, requiredCapabilities: [], routing: { knowledge: 'none', tools: 'none' } }), false);
            } else {
                if (input.stream) received.answer.push(input);
                reply(res, svgAnswer, input.stream);
            }
        });
    } });
    const fixture = createChatFixture({ prefix: 'svg_text', upstreamUrl: upstream.url });
    let handoffs = 0;
    const route = await startChatRouteServer({ fixture, agentExecutionEnabled: true, isRagEnabled: () => false,
        agentRunFactory: async () => { handoffs++; throw new Error('展示 SVG 源码不应建立媒体任务'); } });
    try {
        await saveAssistantMessage({ sessionId: fixture.sessionId, userId: fixture.userId, modelId: fixture.modelId, content: '我无法生成图片，系统没有生图能力。' });
        for (const content of ['请生成svg格式的图片，画一棵树。', '还是要 SVG 格式图片，只需在聊天里展示完整代码，不要调用生图服务。']) {
            const response = await postChat(route.port, { sessionId: fixture.sessionId, modelId: fixture.modelId, content, mcpEnabled: false, ragPreference: 'disabled' });
            assert.equal(response.errorEvent, undefined, JSON.stringify(response.events));
            assert.equal(response.streamedContent, svgAnswer);
            assert.ok(received.intent.at(-1).messages.some(message => message.role === 'system' && message.content.includes(SVG_GENERATION_GUIDANCE)));
            assert.match(received.intent.at(-1).messages[0].content, /仅展示或编写 SVG 源码使用 direct_answer/);
            const messages = received.answer.at(-1).messages;
            assert.ok(messages.some(message => message.role === 'system' && message.content.includes(SVG_GENERATION_GUIDANCE)));
            assert.ok(messages.some(message => message.role === 'user' && message.content.includes(content)));
            assert.ok(messages.some(message => message.role === 'system' && message.content.includes('用户明确要求 SVG 矢量图或绘图源码')));
        }
        assert.ok(received.answer[0].messages.some(message => message.role === 'assistant' && message.content.includes('没有生图能力')));
        assert.equal(handoffs, 0);
        assert.equal(readSessionMessages(fixture).filter(message => message.role === 'assistant').at(-1).content, svgAnswer);
    } finally {
        await route.close(); await upstream.close(); fixture.cleanup();
        if (originalEndpoint === undefined) delete process.env.AGENT_IMAGE_GENERATION_ENDPOINT;
        else process.env.AGENT_IMAGE_GENERATION_ENDPOINT = originalEndpoint;
    }
});

test('可下载 SVG 文件按矢量渲染能力交接任务，不申请媒体生图能力', async () => {
    const { execute } = require('../server/db/client');
    const upstream = await startFakeUpstream({ intentDecision: { action: 'agent_run', objective: '编写树形矢量图并交付 SVG 文件',
        requiredCapabilities: ['viz.render'], routing: { knowledge: 'none', tools: 'task' }, acceptance: { artifactRequired: true } } });
    const fixture = createChatFixture({ prefix: 'svg_task', upstreamUrl: upstream.url });
    const runId = `svg-task-${fixture.sessionId}`;
    let captured;
    const route = await startChatRouteServer({ fixture, agentExecutionEnabled: true, isRagEnabled: () => false,
        agentRunFactory: async options => {
            captured = options;
            await execute("INSERT INTO agent_runs (id,user_id,session_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,NOW(),NOW())",
                [runId, fixture.userId, fixture.sessionId, options.title, options.goal, JSON.stringify(options.metadata)]);
            return { id: runId, status: 'queued' };
        } });
    try {
        const response = await postChat(route.port, { sessionId: fixture.sessionId, modelId: fixture.modelId,
            content: '请生成 SVG 格式的树形图片，并提供可下载的 SVG 文件。', mcpEnabled: false, ragPreference: 'disabled' });
        assert.equal(response.errorEvent, undefined, JSON.stringify(response.events));
        assert.equal(response.findByType('agent_handoff')?.runId, runId);
        assert.ok(captured.metadata.capabilityConstraints.capabilities.includes('viz.render'));
        assert.equal(captured.metadata.capabilityConstraints.capabilities.includes('media.image_generate'), false);
        assert.equal(captured.metadata.taskContract.acceptance.artifactRequired, true);
    } finally { await route.close(); await upstream.close(); fixture.cleanup(); }
});

test('真实图片生成委托保留语义能力并进入任务，不由未配置的关键词检查抢先终止', async () => {
    const { execute } = require('../server/db/client');
    const upstream = await startFakeUpstream({ intentDecision: { action: 'agent_run', objective: '生成山谷插画并撰写配文',
        requiredCapabilities: ['media.image_generate'], routing: { knowledge: 'none', tools: 'task' } } });
    const fixture = createChatFixture({ prefix: 'capability_task', upstreamUrl: upstream.url });
    const runId = `image-task-${fixture.sessionId}`;
    let captured;
    const route = await startChatRouteServer({ fixture, agentExecutionEnabled: true, isRagEnabled: () => false,
        agentRunFactory: async options => {
            captured = options;
            await execute("INSERT INTO agent_runs (id,user_id,session_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,NOW(),NOW())",
                [runId, fixture.userId, fixture.sessionId, options.title, options.goal, JSON.stringify(options.metadata)]);
            return { id: runId, status: 'queued' };
        } });
    try {
        const response = await postChat(route.port, { sessionId: fixture.sessionId, modelId: fixture.modelId,
            content: '请生成一张“绿色山谷插画”，并为它写一段配文。', mcpEnabled: false, ragPreference: 'disabled' });
        assert.equal(response.errorEvent, undefined, JSON.stringify(response.events));
        assert.equal(response.findByType('agent_handoff')?.runId, runId);
        assert.ok(captured.metadata.capabilityConstraints.capabilities.includes('media.image_generate'));
    } finally { await route.close(); await upstream.close(); fixture.cleanup(); }
});

for (const stream of [false, true]) for (const [label, content, answer] of [
    ['媒体术语', '请翻译并概括“生成视频、生成图片、最新新闻”这段文字。', '已完成翻译和概括。'],
    ['SVG 图片', '请生成 SVG 格式的图片，画一棵树，直接展示源码。', svgAnswer]
]) test(`OpenAI 兼容接口按提示词处理${label}，保持${stream ? '流式' : '非流式'}响应`, async () => {
    let captured;
    const upstream = await startFakeUpstream({ handler: (req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => { captured = JSON.parse(body); reply(res, answer, captured.stream); });
    } });
    const fixture = createChatFixture({ prefix: 'capability_openai', upstreamUrl: upstream.url });
    const app = express();
    app.use(express.json());
    app.use(createOpenAIRouter({ authMiddleware: (req, _res, next) => { req.user = fixture.user; next(); }, logAction() {} }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const result = await fetch(`http://127.0.0.1:${server.address().port}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: String(fixture.modelId), messages: [{ role: 'user', content }], stream }) });
        const body = await result.text();
        assert.equal(result.status, 200, body);
        assert.ok(captured, body);
        assert.equal(captured.messages.at(-1).content, content);
        assert.ok(captured.messages.some(message => message.role === 'system' && String(message.content).includes('实际目标和交付要求')));
        assert.ok(captured.messages.some(message => message.role === 'system' && String(message.content).includes(SVG_GENERATION_GUIDANCE)));
        if (stream) { assert.match(result.headers.get('content-type'), /text\/event-stream/); assert.match(body, /\[DONE\]/); }
        else assert.equal(JSON.parse(body).choices[0].message.content, answer);
        if (stream) assert.ok(body.split('\n').filter(line => line.startsWith('data: {')).some(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content === answer));
    } finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); await upstream.close(); fixture.cleanup(); }
});
