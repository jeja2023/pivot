const assert = require('node:assert/strict');
const test = require('node:test');
const { createAppServerProtocol, JSON_RPC_ERRORS } = require('../server/services/app-server-protocol');
const { runMcpConformanceSuite } = require('../server/services/mcp-conformance');
const { createProviderEventStateMachine } = require('../server/streaming');

test('App Server JSON-RPC protocol supports thread, turn control, and event replay', async () => {
    const calls = [];
    const protocol = createAppServerProtocol({
        services: {
            createAgentRun: async options => {
                calls.push({ method: 'create', options });
                return { id: 'run-1', status: 'queued' };
            },
            sendAgentControlMessage: async options => {
                calls.push({ method: 'control', options });
                return { id: 'control-1', status: 'pending' };
            },
            cancelAgentRun: async (runId, user) => ({ id: runId, status: 'cancelled', userId: user.id }),
            replayAgentEventsForUser: async (runId, user, options) => ({ runId, userId: user.id, options, events: [] }),
            residency: {
                touchResident: async options => ({ resident_key: options.residentKey, run_id: options.runId, status: options.status }),
                listResidents: async () => [],
                evictResident: async () => ({ status: 'evicted' }),
                acquireResidentLease: async () => ({ status: 'active' }),
                releaseResidentLease: async () => ({ status: 'idle' }),
                sweepResidents: async () => 0
            }
        }
    });
    const user = { id: 7, role: 'admin' };
    const started = await protocol.handle({ jsonrpc: '2.0', id: 1, method: 'thread/start', params: { goal: '测试任务', residentKey: 'demo-agent' } }, user);
    assert.equal(started.result.thread.id, 'run-1');
    assert.equal(started.result.resident.resident_key, 'demo-agent');
    const turn = await protocol.handle({ jsonrpc: '2.0', id: 2, method: 'turn/start', params: { goal: '继续任务', parentRunId: 'parent-1' } }, user);
    assert.equal(turn.result.turn.threadId, 'run-1');
    assert.equal(calls.filter(item => item.method === 'create').at(-1).options.parentRunId, 'parent-1');
    const steered = await protocol.handle({ jsonrpc: '2.0', id: 3, method: 'turn/steer', params: { runId: 'run-1', message: '调整方向' } }, user);
    assert.equal(steered.result.accepted, true);
    const interrupted = await protocol.handle({ jsonrpc: '2.0', id: 4, method: 'turn/interrupt', params: { runId: 'run-1' } }, user);
    assert.equal(interrupted.result.run.status, 'cancelled');
    const events = await protocol.handle({ jsonrpc: '2.0', id: 5, method: 'turn/events', params: { runId: 'run-1', after: 3 } }, user);
    assert.equal(events.result.options.after, 3);
    assert.equal(await protocol.handle({ jsonrpc: '2.0', method: 'turn/events', params: { runId: 'run-1' } }, user), null);
    await assert.rejects(() => protocol.handle({ jsonrpc: '2.0', id: 6, method: 'missing/method' }, user), error => error.rpcCode === JSON_RPC_ERRORS.methodNotFound);
});

test('MCP conformance harness verifies initialize, session, tools/list, and tools/call', async () => {
    const requests = [];
    const result = await runMcpConformanceSuite({
        toolName: 'echo',
        toolArguments: { value: 'ok' },
        request: async request => {
            requests.push(request);
            if (request.method === 'initialize') {
                return { jsonrpc: '2.0', id: '1', result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } }, headers: { 'Mcp-Session-Id': 'session-1' } };
            }
            if (request.method === 'notifications/initialized') return null;
            if (request.method === 'tools/list') return { jsonrpc: '2.0', id: '2', result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } };
            if (request.method === 'tools/call') return { jsonrpc: '2.0', id: '3', result: { content: [{ type: 'text', text: 'ok' }] } };
            throw new Error(`unexpected method ${request.method}`);
        }
    });
    assert.equal(result.protocolVersion, '2024-11-05');
    assert.equal(result.sessionId, 'session-1');
    assert.equal(result.tool, 'echo');
    assert.deepEqual(requests.map(request => request.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.equal(requests[2].headers['Mcp-Session-Id'], 'session-1');
    assert.deepEqual(requests[3].params.arguments, { value: 'ok' });
});

test('Provider event state machine classifies Responses and Chat Completions usage/tool events', () => {
    const events = [];
    const machine = createProviderEventStateMachine({ onEvent: event => events.push(event) });
    machine.ingest({ type: 'response.created', response: { id: 'resp-1' } });
    machine.ingest({ type: 'response.output_text.delta', delta: '你好' });
    machine.ingest({ type: 'response.usage', usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } });
    machine.ingest({ type: 'response.completed' });
    const responses = machine.finalize();
    assert.equal(responses.protocol, 'responses');
    assert.equal(responses.responseId, 'resp-1');
    assert.equal(responses.outputText, '你好');
    assert.equal(responses.usage.totalTokens, 5);
    assert.equal(responses.status, 'completed');
    assert.equal(events.length, 4);

    const chat = createProviderEventStateMachine();
    chat.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'echo', arguments: '{"v":' } }] } }] });
    chat.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] });
    chat.ingest({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } });
    const chatSnapshot = chat.finalize();
    assert.equal(chatSnapshot.protocol, 'chat_completions');
    assert.equal(chatSnapshot.toolCalls[0].name, 'echo');
    assert.equal(chatSnapshot.toolCalls[0].arguments, '{"v":1}');
    assert.equal(chatSnapshot.usage.inputTokens, 4);
    assert.equal(chatSnapshot.finishReason, 'tool_calls');
});
