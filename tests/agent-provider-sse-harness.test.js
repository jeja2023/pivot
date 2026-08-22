'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { callModelStreamingWithTools } = require('../server/services/agent-model');
const { createModelItemEnvelope } = require('../server/services/agent-provider-envelope');
const { tryRunAgentStreaming } = require('../server/services/agent-streaming-runtime');
const { createAgentStepContext } = require('../server/services/agent-step-context');

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
            synthesizeFinalAnswer: async () => 'unexpected fallback',
            createAgentNotification: async () => {},
            getAgentRunTitle: () => 'mock run'
        });

        assert.deepEqual(result, { completed: true, roundsUsed: 2 });
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
