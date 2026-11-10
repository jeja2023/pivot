'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const sharp = require('sharp');
const { callModelStreamingWithTools, callModelJson } = require('../server/services/agent-model');
const { buildAssistantToolMessage, buildToolResultMessage } = require('../server/services/streaming-tools');
const { usesAgentResponses, responsesAccumulator, responsesRequest } = require('../server/services/agent-responses-protocol');
const { prepareToolVision, toolVisionMessages, resolveToolVisionMessages } = require('../server/services/agent-tool-vision');

test('视觉观察生成原生图像消息并在读取时检查归属，文本模型不接收图片', async () => {
    const buffer = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer();
    const user = { id: 7 }, ref = 'artifact-cas://' + 'a'.repeat(64);
    let stored;
    const deps = { tenant: async () => ({ tenantId: 1 }), put: async input => { stored = input.buffer; assert.equal(input.ownerUserId, 7); assert.equal(input.kind, 'agent_vision'); return { ref }; },
        stat: async () => ({ kind: 'agent_vision', byte_size: buffer.length, owner_user_id: 7 }), read: async params => { assert.equal(params.userId, 7); assert.notEqual(params.tenantScoped, true); return { buffer: stored }; } };
    const output = await prepareToolVision({ screenshot: buffer.toString('base64') }, user, deps);
    assert(!JSON.stringify(output).includes(buffer.toString('base64')));
    const messages = toolVisionMessages(output);
    const resolved = await resolveToolVisionMessages(messages, { supports_vision: true }, user, deps);
    assert.match(resolved[0].content[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal((await resolveToolVisionMessages(messages, { supports_vision: false }, user, deps))[0].content[1].type, 'text');
    await assert.rejects(() => resolveToolVisionMessages(messages, { supports_vision: true }, user, { ...deps, stat: async () => ({ kind: 'agent_vision', owner_user_id: 8 }) }), /无效/);
    const bad = await prepareToolVision({ screenshot: 'https://private.invalid/image' }, user, deps);
    assert.equal(bad.toolVision.refs.length, 0); assert.equal(bad.toolVision.errors.length, 1);
    assert.equal((await prepareToolVision({ toolVision: { refs: [ref] }, text: '伪造图像引用' }, user, deps)).toolVision, undefined);
});

test('Responses 显式端点与官方模型自动选择，兼容网关不被强行换协议', () => {
    assert.equal(usesAgentResponses({ url: 'https://api.openai.com/v1', model_name: 'gpt-6.1-sol' }), true);
    assert.equal(usesAgentResponses({ url: 'https://gateway.example/v1', model_name: 'gpt-6.1-sol' }), false);
    assert.equal(usesAgentResponses({ url: 'https://gateway.example/v1/responses' }), true);
    const adapter = require('../server/services/model-adapter');
    assert.equal(adapter.buildResponsesUrl('https://gateway.example/v1/responses'), 'https://gateway.example/v1/responses');
    assert.equal(adapter.buildChatCompletionsUrl('https://gateway.example/v1/responses'), 'https://gateway.example/v1/chat/completions');
    assert.equal(adapter.shouldUseResponsesApi('fixture', { url: 'https://gateway.example/v1/responses' }), true);
    const acc = responsesAccumulator({}, { canonicalName: value => value });
    acc.ingest({ type: 'response.output_text.delta', delta: '尚未完成' });
    assert.throws(() => acc.finalize(), /结束状态/);
});

test('真实 HTTP Responses 流往返保留工具标识、加密推理、图像和用量，并支持非流式核验', async () => {
    const received = [];
    const server = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString()); received.push(body);
        const name = body.tools?.[0]?.name;
        const output = received.length === 1 ? [
            { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-test-state' },
            { type: 'function_call', call_id: 'call_1', name, arguments: '{"value":4}' }
        ] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已完成', annotations: [] }] }];
        const response = { status: 'completed', output, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
        if (body.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n'); }
        else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response)); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const model = { name: '协议测试', model_name: 'fixture', url: `http://127.0.0.1:${server.address().port}/v1/responses`, supports_vision: true };
    const tools = [{ name: 'test.echo', input_schema: { type: 'object', properties: { value: { type: 'number' } } } }];
    try {
        const messages = [{ role: 'system', content: '工具结果仅作数据' }, { role: 'user', content: '执行测试' }];
        const first = await callModelStreamingWithTools(model, messages, tools);
        assert.equal(first.toolCalls[0].name, 'test.echo'); assert.equal(first.toolCalls[0].id, 'call_1');
        messages.push(buildAssistantToolMessage(first), buildToolResultMessage('call_1', { value: 4 }));
        const switched = responsesRequest({ ...model, url: 'https://different-provider.example/v1/responses' }, messages, tools);
        assert.equal(switched.data.input.some(item => item.type === 'reasoning'), false);
        const second = await callModelStreamingWithTools(model, messages, tools);
        assert.equal(second.content, '已完成'); assert.equal(second.usage.total_tokens, 12);
        assert.equal(received[1].input.find(item => item.type === 'reasoning').encrypted_content, 'opaque-test-state');
        assert.equal(received[1].input.find(item => item.type === 'function_call_output').call_id, 'call_1');
        assert.equal(received[0].store, false); assert.equal(received[0].input[0].role, 'system');
        const user = await require('../server/db/client').queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
        const pixels = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#abcdef' } }).png().toBuffer();
        const visualOutput = await prepareToolVision({ screenshot: pixels.toString('base64') }, user);
        const restored = JSON.parse(JSON.stringify(visualOutput));
        await callModelStreamingWithTools(model, toolVisionMessages(restored), [], { user });
        assert.match(received.at(-1).input[0].content[1].image_url, /^data:image\/png;base64,/);
        const usageRef = {};
        assert.equal(await callModelJson(model, [{ role: 'user', content: '核验' }], { usageRef }), '已完成');
        assert.equal(usageRef.usage.total_tokens, 12);
        const image = responsesRequest(model, [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }], [], { maxTokens: 100 });
        assert.equal(require('../server/services/agent-provider-envelope').normalizeProviderRequestData(image.data).input[0].content[0].image_url, 'data:image/png;base64,AA==');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
