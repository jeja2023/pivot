const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { executeBuiltInTool } = require('../server/services/agent-tools');
const { getBuiltInToolDefinitions } = require('../server/services/agent-tools');
const { BUILTIN_TOOL_CAPABILITIES } = require('../server/services/agent-tool-capabilities');
const { buildPlatformImPayload, deliverIm } = require('../server/services/agent-channel-adapters');
const { normalizeBindingInput } = require('../server/services/agent-channels');

process.env.NODE_ENV = 'test';
process.env.PIVOT_AGENT_UNSAFE_LOCAL_TEST = 'true';

test('workflow.foreach executes items in a separate controlled worker with bounded output', async () => {
    const result = await executeBuiltInTool('workflow.foreach', {
        items: [1, 2, 3],
        code: 'return item * 2;',
        concurrency: 2,
        retryLimit: 0
    }, { id: 1 }, { sandboxExecution: true, approvalGranted: true, allowUnsafeLocal: true, runId: 'foreach-worker-test' });
    assert.deepEqual(result.items, [2, 4, 6]);
    assert.equal(result.count, 3);
    assert.equal(result.errors.length, 0);
    assert.equal(result.worker.code, 0);
    const expectedNetworkIsolation = process.platform === 'linux' ? 'namespace_requested' : 'not_enforced';
    assert.equal(result.worker.isolation.networkIsolation, expectedNetworkIsolation);
    assert.equal(result.worker.isolation.enforcement, 'best_effort');
    assert.equal(result.audit.requestedConcurrency, 2);
    assert.equal(result.audit.maxConcurrency, 2);
    assert.equal(result.audit.completedCount, 3);
    assert.equal(result.audit.failedCount, 0);
});

test('workflow.foreach isolates item errors and retries within the worker', async () => {
    const result = await executeBuiltInTool('workflow.foreach', {
        items: [1, 2],
        code: 'if (item === 2) throw new Error("错误项"); return item;',
        concurrency: 1,
        stopOnError: false,
        retryLimit: 1
    }, { id: 1 }, { sandboxExecution: true, approvalGranted: true, allowUnsafeLocal: true, runId: 'foreach-error-test' });
    assert.deepEqual(result.items, [1]);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].attempts, 2);
    assert.equal(result.errors[0].code, 'AGENT_FOREACH_ITEM_FAILED');
    assert.equal(result.audit.retryCount, 1);
});

test('workflow.foreach enforces item timeout and per-item output limits', async () => {
    const timeoutResult = await executeBuiltInTool('workflow.foreach', {
        items: [1],
        code: 'while (true) {}',
        itemTimeoutMs: 50,
        stopOnError: false
    }, { id: 1 }, { sandboxExecution: true, approvalGranted: true, allowUnsafeLocal: true, runId: 'foreach-timeout-test' });
    assert.equal(timeoutResult.errors[0].code, 'AGENT_FOREACH_ITEM_TIMEOUT');

    const outputResult = await executeBuiltInTool('workflow.foreach', {
        items: [1],
        code: 'return "x".repeat(200001);',
        stopOnError: false
    }, { id: 1 }, { sandboxExecution: true, approvalGranted: true, allowUnsafeLocal: true, runId: 'foreach-output-test' });
    assert.equal(outputResult.errors[0].code, 'AGENT_FOREACH_ITEM_OUTPUT_LIMIT');

    const totalOutputResult = await executeBuiltInTool('workflow.foreach', {
        items: Array.from({ length: 8 }, () => 'y'.repeat(150000)),
        code: 'return item;',
        concurrency: 4,
        stopOnError: false,
        itemTimeoutMs: 5000
    }, { id: 1 }, { sandboxExecution: true, approvalGranted: true, allowUnsafeLocal: true, runId: 'foreach-total-output-test' });
    assert.ok(totalOutputResult.errors.some(error => error.code === 'AGENT_FOREACH_TOTAL_OUTPUT_LIMIT'));
});

test('workflow.foreach worker does not expose the host process or require chain', async () => {
    const result = await executeBuiltInTool('workflow.foreach', {
        items: [1],
        code: 'return typeof process + ":" + typeof require + ":" + this.constructor.constructor("return typeof process")();'
    }, { id: 1 }, { sandboxExecution: true, approvalGranted: true, allowUnsafeLocal: true, runId: 'foreach-isolation-test' });
    assert.deepEqual(result.items, ['undefined:undefined:undefined']);
});

test('workflow.foreach direct in-process calls remain blocked', async () => {
    await assert.rejects(
        () => executeBuiltInTool('workflow.foreach', { items: [1], code: 'return item;' }, { id: 1 }),
        error => error.code === 'AGENT_SANDBOX_REQUIRED' && error.status === 403
    );
    await assert.rejects(
        () => executeBuiltInTool('workflow.foreach', { items: [1], code: 'return item;' }, { id: 1 }, { sandboxExecution: true }),
        error => error.code === 'AGENT_SANDBOX_REQUIRED' && error.status === 403
    );
});

test('workflow.foreach worker responds to cancellation', async () => {
    const controller = new AbortController();
    const pending = executeBuiltInTool('workflow.foreach', {
        items: [1],
        code: 'while (true) {}',
        itemTimeoutMs: 5000
    }, { id: 1 }, { sandboxExecution: true, approvalGranted: true, allowUnsafeLocal: true, runId: 'foreach-cancel-test', signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, error => ['AGENT_SANDBOX_CANCELLED', 'AGENT_RUN_CANCELLED', 'ABORT_ERR'].includes(error.code) || error.name === 'AbortError');
});

test('platform notification payloads use provider-specific schemas without leaking credentials', () => {
    const delivery = { subject: '标题', body: '**正文**', interaction: JSON.stringify({ format: 'markdown' }) };
    assert.deepEqual(buildPlatformImPayload('wecom', delivery), { msgtype: 'markdown', markdown: { content: '**正文**' } });
    assert.equal(buildPlatformImPayload('feishu', delivery).msg_type, 'post');
    assert.equal(buildPlatformImPayload('dingtalk', delivery).msgtype, 'markdown');
    assert.equal(normalizeBindingInput({ channelType: 'im', channelKey: 'binding-target', config: { platform: 'wecom', url: 'https://example.invalid/hook' } }).config.platform, 'wecom');
    assert.throws(() => normalizeBindingInput({ channelType: 'im', channelKey: 'binding-target', config: { platform: 'wecom' } }), /Webhook Endpoint/);
});

test('platform notification adapters send governed payloads through the safe HTTP client', async () => {
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            requests.push({ url: req.url, payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ errcode: 0 }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        for (const platform of ['wecom', 'feishu', 'dingtalk']) {
            await deliverIm({
                channel_key: 'test-target',
                config: JSON.stringify({ platform, url: `http://127.0.0.1:${port}/notify` })
            }, {
                subject: '测试标题',
                body: '**测试正文**',
                interaction: JSON.stringify({ format: 'markdown' }),
                idempotency_key: `test-${platform}`
            }, { id: 1, role: 'admin' });
        }
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
    assert.equal(requests.length, 3);
    assert.equal(requests[0].payload.msgtype, 'markdown');
    assert.equal(requests[1].payload.msg_type, 'post');
    assert.equal(requests[2].payload.msgtype, 'markdown');
});

test('workflow.notify is a governed side-effect tool backed by channel bindings', () => {
    const tool = getBuiltInToolDefinitions({ id: 1 }).find(item => item.name === 'workflow.notify');
    assert.equal(tool?.side_effect, true);
    assert.equal(tool?.alwaysRequiresApproval, true);
    assert.deepEqual(tool?.input_schema?.required, ['bindingId', 'body']);
    assert.deepEqual(BUILTIN_TOOL_CAPABILITIES['workflow.notify'], ['network.http_request']);
    assert.match(tool.description, /不接受裸 Webhook URL/);
});
