'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { callModelStreamingWithTools } = require('../server/services/agent-model');
const { createModelItemEnvelope } = require('../server/services/agent-provider-envelope');
const { createStreamingSnapshotSampler, tryRunAgentStreaming } = require('../server/services/agent-streaming-runtime');
const { createAgentStepContext } = require('../server/services/agent-step-context');
const { TaskBudget } = require('../server/services/agent-budget');
const NETWORK_TIMEOUT_DRILL_MS = 2_000;

test('streaming sampler merges UI updates and reserves one audit snapshot for completion', () => {
    const sampler = createStreamingSnapshotSampler({ maxAuditSnapshots: 4, uiIntervalMs: 100, auditIntervalMs: 1000, auditMinGrowth: 3 });
    assert.equal(sampler.sampleUi({ content: 'a' }, 0), true);
    assert.equal(sampler.sampleUi({ content: 'ab' }, 10), false);
    assert.equal(sampler.sampleUi({ content: 'a'.repeat(121) }, 20), true);
    assert.equal(sampler.sampleAudit({ content: 'a' }, { now: 0 }).index, 1);
    assert.equal(sampler.sampleAudit({ content: 'ab' }, { now: 10 }), null);
    assert.equal(sampler.sampleAudit({ content: 'abcd' }, { now: 20 }).index, 2);
    assert.equal(sampler.sampleAudit({ content: 'abcde' }, { now: 30 }), null);
    assert.equal(sampler.sampleAudit({ content: 'abcdefg' }, { now: 40 }).index, 3);
    assert.equal(sampler.sampleAudit({ content: 'abcdef', finishReason: 'stop' }, { completed: true, now: 50 }).index, 4);
    assert.equal(sampler.getAuditCount(), 4);
});

test('暂停和租约丢失不会触发原生工具降级，验收后的迟到结果不能覆盖暂停', async () => {
    const run = { id: 'stop-stream', user_id: 7, goal: '查询知识库', max_steps: 3, run_mode: 'standard' };
    const options = { run, user: { id: 7 }, modelCfg: { id: 3 }, runId: run.id, toolList: [], deadline: Date.now() + 30000,
        assertRunWithinBudget() {}, assertRunNotCancelled: async () => {}, observations: [] };
    for (const code of ['AGENT_RUN_PAUSED', 'AGENT_RUN_LEASE_LOST']) {
        const steps = [];
        const deps = streamingDeps({ run, steps, events: [], maybePauseForApproval: async () => false });
        deps.callModelStreamingWithTools = async () => { throw Object.assign(new Error('执行已中断'), { code }); };
        await assert.rejects(() => tryRunAgentStreaming(options, deps), error => error.code === code);
        assert.equal(steps.length, 0);
    }
    let paused = false;
    const updates = [];
    const deps = streamingDeps({ run, steps: [], events: [] });
    deps.callModelStreamingWithTools = async () => ({ content: '已有答案', hasToolCalls: false, toolCalls: [] });
    deps.updateRun = async (_id, fields) => updates.push(fields);
    deps.verifyAgentOutcome = async () => { paused = true; return { outcomeStatus: 'verified', hardFailures: [] }; };
    await assert.rejects(() => tryRunAgentStreaming({ ...options, assertRunNotCancelled: async () => {
        if (paused) throw Object.assign(new Error('用户已暂停'), { code: 'AGENT_RUN_PAUSED' });
    } }, deps), error => error.code === 'AGENT_RUN_PAUSED');
    assert.equal(updates.some(fields => fields.status === 'completed'), false);
});

test('Token 耗尽后不追加模型总结或调用工具，已有结果仍可结束', async () => {
    const run = { id: 'budget-stream', user_id: 7, goal: '查询资料', max_steps: 3, run_mode: 'standard' };
    const updates = [];
    const deps = streamingDeps({ run, steps: [], events: [] });
    deps.callModelStreamingWithTools = async () => ({ content: '', hasToolCalls: true, toolCalls: [{ id: 'call-1', name: 'rag.search', arguments: {} }] });
    deps.recordAgentModelUsage = async () => ({ budgetExceeded: true });
    deps.synthesizeFinalAnswer = async () => { throw new Error('额度耗尽后不应再调用模型'); };
    deps.executeToolByName = async () => { throw new Error('额度耗尽后不应调用工具'); };
    deps.updateRun = async (_id, fields) => updates.push(fields);
    const result = await tryRunAgentStreaming({ run, user: { id: 7 }, modelCfg: { id: 3 }, runId: run.id, toolList: [], deadline: Date.now() + 30000,
        assertRunWithinBudget() {}, assertRunNotCancelled: async () => {}, observations: [] }, deps);
    assert.equal(result.completed, true);
    assert.equal(updates.at(-1).status, 'completed_with_errors');
});

test('最终答案验收持久化失败不会伪装成模型不支持工具再执行一轮', async () => {
    const run = { id: 'verify-failure', user_id: 7, goal: '生成答案', max_steps: 3, run_mode: 'standard' };
    const steps = [];
    const deps = streamingDeps({ run, steps, events: [] });
    deps.callModelStreamingWithTools = async () => ({ content: '已有答案', hasToolCalls: false, toolCalls: [] });
    deps.verifyAgentOutcome = async () => { throw Object.assign(new Error('验收存储暂时不可用'), { code: 'VERIFY_STORE_UNAVAILABLE' }); };
    await assert.rejects(() => tryRunAgentStreaming({ run, user: { id: 7 }, modelCfg: { id: 3 }, runId: run.id, toolList: [], deadline: Date.now() + 30000,
        assertRunWithinBudget() {}, assertRunNotCancelled: async () => {}, observations: [] }, deps), error => error.code === 'VERIFY_STORE_UNAVAILABLE');
    assert.equal(steps.length, 1);
    assert.equal(steps[0].title, '流式最终答案');
});

test('流式检查点恢复携带已完成工具结果和已应用指令，避免丢失进度从头执行', async () => {
    const run = { id: 'checkpoint-stream', user_id: 7, goal: '继续分析结果', max_steps: 3, run_mode: 'standard', resume_from_step: 4 };
    let input;
    const deps = streamingDeps({ run, steps: [], events: [] });
    deps.callModelStreamingWithTools = async (_model, messages) => { input = messages; return { content: '基于已完成检索给出结果', hasToolCalls: false, toolCalls: [] }; };
    const result = await tryRunAgentStreaming({ run, user: { id: 7 }, modelCfg: { id: 3 }, runId: run.id, toolList: [], deadline: Date.now() + 30000,
        assertRunWithinBudget() {}, assertRunNotCancelled: async () => {}, observations: [
            { step: 4, tool: 'rag.search', output: { content: '已检索到的真实资料', sources: ['制度'] } },
            { type: 'agent_control', payload: { instruction: '仅汇总现有结果，不重复检索' }, restored: true }
        ] }, deps);
    assert.equal(result.roundsUsed, 5);
    const context = input.map(message => message.content).join('\n');
    assert.match(context, /已检索到的真实资料/);
    assert.match(context, /仅汇总现有结果，不重复检索/);
    assert.match(context, /PIVOT_MCP_TOOL_RESULT_BEGIN/);
});

function startMockProvider(received) {
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            received.push({ method: req.method, url: req.url, body });
            res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                connection: 'keep-alive'
            });
            const send = frame => res.write(`data: ${JSON.stringify(frame)}\n\n`);
            const messages = Array.isArray(body.messages) ? body.messages : [];
            const toolResult = messages.find(message => message.role === 'tool');
            const boundaryProbe = messages.some(message => message.content === 'provider-boundary');
            if (toolResult) {
                send({ choices: [{ delta: { content: '工具已执行' } }] });
                send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
            } else if (boundaryProbe) {
                send({ choices: [{ delta: { content: '边界已验证' } }] });
                send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
            } else {
                send({
                    choices: [{
                        delta: {
                            tool_calls: [{
                                index: 0,
                                id: 'call_echo',
                                type: 'function',
                                function: { name: 'test.echo', arguments: '{"value":"' }
                            }]
                        }
                    }]
                });
                send({
                    choices: [{
                        delta: { tool_calls: [{ index: 0, function: { arguments: 'from tool"}' } }] }
                    }]
                });
                send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
            }
            res.write('data: [DONE]\n\n');
            res.end();
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function closeServer(server) {
    // 流式超时演练会刻意保留一个无结束帧的 keep-alive socket；Node 的
    // server.close() 会等待该连接自然结束，导致断言完成后测试仍悬挂。
    server.closeAllConnections?.();
    return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function streamingDeps({ run, _modelCfg, _toolList, steps, events, executeToolByName, maybePauseForApproval }) {
    return {
        agentToolTimeoutMs: 30_000,
        logger: { warn: () => {} },
        listSteps: async () => steps,
        insertStep: async (_runId, _stepIndex, step) => { steps.push(step); },
        captureStepContext: async options => createAgentStepContext(options),
        recordAgentEvent: async event => { events.push(event); },
        recordNativeToolCallCapability: async () => {},
        recordAgentModelUsage: async () => {},
        recordAgentToolCall: async () => {},
        callModelStreamingWithTools,
        executeToolByName,
        compactToolOutputForModel: value => value,
        withTimeout: async execute => execute(null),
        updateRun: async () => {},
        startAgentTraceSpan: async () => 'span',
        finishAgentTraceSpan: async () => {},
        publishUserEvent: () => {},
        maybePauseForApproval,
        getRunMetadata: () => ({}),
        synthesizeFinalAnswer: async () => 'unexpected fallback',
        createAgentNotification: async () => {},
        getAgentRunTitle: () => run.title || 'mock run'
    };
}

test('mock SSE harness verifies provider isolation, tool execution, and next model request', async () => {
    const received = [];
    const server = await startMockProvider(received);
    const port = server.address().port;
    const modelCfg = {
        id: 1,
        name: 'mock-sse-model',
        model_name: 'mock-sse-model',
        url: `http://127.0.0.1:${port}`,
        api_key: ''
    };
    try {
        const boundaryResult = await callModelStreamingWithTools(modelCfg, [
            createModelItemEnvelope(
                { role: 'user', content: 'provider-boundary' },
                { metadata: { credential: 'must-not-leak' }, contextHash: 'private-context' }
            )
        ]);
        assert.equal(boundaryResult.content, '边界已验证');
        assert.ok(boundaryResult.timing.firstByteAt);
        assert.ok(boundaryResult.timing.firstFrameAt);
        assert.ok(boundaryResult.timing.bytesReceived > 0);
        assert.equal(Object.hasOwn(received[0].body.messages[0], 'metadata'), false);
        assert.equal(Object.hasOwn(received[0].body.messages[0], 'contextHash'), false);

        const steps = [];
        const events = [];
        const executed = [];
        const run = {
            id: 'mock-sse-run',
            user_id: 7,
            goal: '调用 echo 工具后回答',
            run_mode: 'standard',
            max_steps: 3,
            tool_policy: 'all',
            approval_policy: 'safe_mcp_auto',
            context_config: {},
            metadata: {}
        };
        const toolList = [{
            name: 'test.echo',
            title: 'Echo',
            description: 'Echo a value',
            source: 'builtin',
            idempotent: true,
            input_schema: { type: 'object', properties: { value: { type: 'string' } } }
        }];
        const taskBudget = new TaskBudget({ max_steps: 2, max_tool_calls: 1 });
        const capabilityRecords = [];
        const result = await tryRunAgentStreaming({
            run,
            user: { id: 7, role: 'admin' },
            modelCfg,
            toolList,
            runId: run.id,
            deadline: Date.now() + 30_000,
            assertRunWithinBudget: () => {},
            assertRunNotCancelled: async () => {},
            observations: []
        }, {
            agentToolTimeoutMs: 30_000,
            logger: { warn: () => {} },
            listSteps: async () => steps,
            insertStep: async (_runId, _stepIndex, step) => { steps.push(step); },
            captureStepContext: async options => createAgentStepContext(options),
            recordAgentEvent: async event => { events.push(event); },
            recordNativeToolCallCapability: async (_cfg, result) => { capabilityRecords.push(result); },
            recordAgentModelUsage: async () => {},
            recordAgentToolCall: async () => {},
            callModelStreamingWithTools,
            executeToolByName: async (name, input) => {
                executed.push({ name, input });
                return { echo: input.value };
            },
            compactToolOutputForModel: value => value,
            withTimeout: async execute => execute(null),
            updateRun: async () => {},
            startAgentTraceSpan: async () => 'span',
            finishAgentTraceSpan: async () => {},
            publishUserEvent: () => {},
            maybePauseForApproval: async () => false,
            getRunMetadata: () => ({}),
            taskBudget,
            synthesizeFinalAnswer: async () => 'unexpected fallback',
            createAgentNotification: async () => {},
            getAgentRunTitle: () => 'mock run'
        });

        assert.deepEqual(result, { completed: true, roundsUsed: 2 });
        assert.equal(taskBudget.snapshot().counts.steps, 2);
        assert.equal(taskBudget.snapshot().counts.tool_calls, 1);
        assert.equal(taskBudget.snapshot().counts.consecutive_errors, 0);
        assert.deepEqual(executed, [{ name: 'test.echo', input: { value: 'from tool' } }]);
        assert.equal(received.length, 3);
        const secondTurnMessages = received[2].body.messages;
        const assistantToolCall = secondTurnMessages.find(message => message.role === 'assistant' && Array.isArray(message.tool_calls));
        const toolResult = secondTurnMessages.find(message => message.role === 'tool');
        assert.equal(assistantToolCall.tool_calls[0].function.name, 'test.echo');
        assert.deepEqual(JSON.parse(toolResult.content), { echo: 'from tool' });
        assert.equal(events.filter(event => event.type === 'model.requested').length, 2);
        assert.equal(events.filter(event => event.type === 'model.completed').length, 2);
        const deltaEvents = events.filter(event => event.type === 'model.delta');
        assert.ok(deltaEvents.length >= 2);
        assert.ok(deltaEvents.some(event => event.payload.partialToolCalls.some(call => call.name === 'test.echo')));
        assert.ok(deltaEvents.some(event => event.payload.completed === true));
        assert.deepEqual(capabilityRecords, [{ status: 'supported', protocol: 'chat_completions' }]);
    } finally {
        await closeServer(server);
    }
});

test('mock SSE harness propagates provider disconnect and cancellation', async () => {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
            if (req.url.includes('disconnect')) {
                setTimeout(() => res.destroy(new Error('mock provider disconnected')), 10);
            }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const modelCfg = { id: 2, name: 'mock-disconnect', model_name: 'mock-disconnect', url: `http://127.0.0.1:${port}`, api_key: '' };
    try {
        const controller = new AbortController();
        const pending = callModelStreamingWithTools(modelCfg, [{ role: 'user', content: 'cancel' }], [], { signal: controller.signal });
        setTimeout(() => controller.abort(), 20);
        await assert.rejects(pending, error => Boolean(error));
    } finally {
        await closeServer(server);
    }
});

test('Agent 流建立后长期无新数据会按无进展策略中止', async () => {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
            res.flushHeaders();
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const modelCfg = { id: 9, name: 'mock-idle', model_name: 'mock-idle', url: `http://127.0.0.1:${port}`, api_key: '' };
    try {
        await assert.rejects(
            () => callModelStreamingWithTools(modelCfg, [{ role: 'user', content: 'idle' }], [], {
                firstResponseTimeoutMs: NETWORK_TIMEOUT_DRILL_MS,
                streamIdleTimeoutMs: NETWORK_TIMEOUT_DRILL_MS
            }),
            error => error?.code === 'AGENT_MODEL_STREAM_IDLE'
        );
    } finally {
        await closeServer(server);
    }
});

test('Agent 模型在首响应时限内未开始响应会给出可诊断错误码', async () => {
    const server = http.createServer(req => {
        req.resume();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const modelCfg = { id: 10, name: 'mock-first-response', model_name: 'mock-first-response', url: `http://127.0.0.1:${port}`, api_key: '' };
    try {
        await assert.rejects(
            () => callModelStreamingWithTools(modelCfg, [{ role: 'user', content: 'first-response' }], [], {
                firstResponseTimeoutMs: NETWORK_TIMEOUT_DRILL_MS,
                streamIdleTimeoutMs: NETWORK_TIMEOUT_DRILL_MS
            }),
            error => error?.code === 'AGENT_MODEL_FIRST_RESPONSE_TIMEOUT' && error.agentModelTiming?.firstByteAt === null
        );
    } finally {
        await closeServer(server);
    }
});

test('mock SSE harness covers approval pause and recoverable tool failure', async () => {
    const received = [];
    const server = await startMockProvider(received);
    const port = server.address().port;
    const modelCfg = { id: 3, name: 'mock-recovery', model_name: 'mock-recovery', url: `http://127.0.0.1:${port}`, api_key: '' };
    const toolList = [{ name: 'test.echo', title: 'Echo', source: 'builtin', idempotent: false, input_schema: { type: 'object' } }];
    const baseRun = { id: 'mock-recovery-run', user_id: 7, goal: '恢复工具失败', run_mode: 'standard', max_steps: 3, tool_policy: 'all', approval_policy: 'safe_mcp_auto', context_config: {}, metadata: {} };
    try {
        const approvalSteps = [];
        const approvalEvents = [];
        let approvalExecutions = 0;
        const paused = await tryRunAgentStreaming({
            run: { ...baseRun, id: `${baseRun.id}-approval` }, user: { id: 7, role: 'admin' }, modelCfg, toolList,
            runId: `${baseRun.id}-approval`, deadline: Date.now() + 30_000, assertRunWithinBudget: () => {},
            assertRunNotCancelled: async () => {}, observations: []
        }, streamingDeps({
            run: baseRun, modelCfg, toolList, steps: approvalSteps, events: approvalEvents,
            executeToolByName: async () => { approvalExecutions += 1; return { ok: true }; },
            maybePauseForApproval: async () => true
        }));
        assert.deepEqual(paused, { completed: true, roundsUsed: 1 });
        assert.equal(approvalExecutions, 0);

        const failureSteps = [];
        const failureEvents = [];
        const failed = await tryRunAgentStreaming({
            run: { ...baseRun, id: `${baseRun.id}-failure` }, user: { id: 7, role: 'admin' }, modelCfg, toolList,
            runId: `${baseRun.id}-failure`, deadline: Date.now() + 30_000, assertRunWithinBudget: () => {},
            assertRunNotCancelled: async () => {}, observations: []
        }, streamingDeps({
            run: baseRun, modelCfg, toolList, steps: failureSteps, events: failureEvents,
            executeToolByName: async () => { throw Object.assign(new Error('mock tool failure'), { code: 'MOCK_TOOL_FAILED' }); },
            maybePauseForApproval: async () => false
        }));
        assert.deepEqual(failed, { completed: true, roundsUsed: 2 });
        assert.ok(failureSteps.some(step => step.status === 'error' && step.toolName === 'test.echo'));
        assert.ok(failureEvents.some(event => event.type === 'model.completed'));
        assert.equal(received.length, 3);
    } finally {
        await closeServer(server);
    }
});
