'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildWorldState,
    buildWorldStatePrompt,
    buildWorldStateInjection,
    createAgentStepContext
} = require('../server/services/agent-step-context');
const { createToolOrchestrator } = require('../server/services/agent-tool-orchestrator');
const {
    assertProviderSafe,
    createModelItemEnvelope,
    normalizeProviderRequestData,
    toProviderInput
} = require('../server/services/agent-provider-envelope');

test('WorldState is deterministic and AgentStepContext is immutable', () => {
    const run = {
        id: 'run-1',
        goal: '分析销售额',
        run_mode: 'standard',
        tool_policy: 'all',
        metadata: { workflowId: 9, skillId: 'pivot-analysis', secret: 'should-not-be-in-state' }
    };
    const model = { id: 3, name: '分析模型', model_name: 'model-a', context_window: 32000 };
    const tools = [
        { name: 'db.query', source: 'builtin', capabilities: ['read'], idempotent: true },
        { name: 'reports.export', source: 'builtin', side_effect: true }
    ];
    const first = buildWorldState({ run, modelCfg: model, toolList: tools, contextConfig: { locale: 'zh-CN' } });
    const second = buildWorldState({ run, modelCfg: model, toolList: tools.slice().reverse(), contextConfig: { locale: 'zh-CN' } });
    assert.equal(first.hash, second.hash);
    assert.equal(first.extensions.skillId, 'pivot-analysis');
    assert.equal(Object.hasOwn(first.extensions, 'secret'), false);

    const context = createAgentStepContext({ run, turnId: 'turn-1', stepIndex: 2, modelCfg: model, toolList: tools, worldState: first });
    assert.equal(context.worldStateHash, first.hash);
    assert.equal(Object.isFrozen(context), true);
    assert.equal(Object.isFrozen(context.worldState), true);
    assert.throws(() => { context.stepIndex = 99; }, TypeError);

    const prompt = buildWorldStatePrompt(first);
    assert.match(prompt, /^PIVOT_WORLD_STATE_BEGIN\n/);
    assert.match(prompt, /"hash":"[a-f0-9]{64}"/);
    assert.match(prompt, /\nPIVOT_WORLD_STATE_END$/);
});

test('WorldState uses reference or diff injection after a full baseline', () => {
    const run = { id: 'run-diff', goal: 'goal', tool_policy: 'all', metadata: {} };
    const model = { id: 1, name: 'model' };
    const baseline = buildWorldState({ run, modelCfg: model, contextConfig: { notes: 'a' } });
    const unchanged = buildWorldStateInjection(baseline, baseline);
    assert.equal(unchanged.mode, 'reference');
    assert.equal(unchanged.baseHash, baseline.hash);

    const changed = buildWorldState({ run: { ...run, goal: 'changed goal' }, modelCfg: model, contextConfig: { notes: 'a' } });
    const injection = buildWorldStateInjection(changed, baseline);
    assert.equal(injection.mode, 'diff');
    assert.equal(injection.baseHash, baseline.hash);
    assert.ok(injection.patch.some(item => item.path === '/run/goal'));
    const prompt = buildWorldStatePrompt(changed, { injection });
    assert.match(prompt, /"mode":"diff"/);
    assert.match(prompt, /\/run\/goal/);
});

test('Provider envelope strips internal metadata while preserving model protocol fields', () => {
    const envelope = createModelItemEnvelope({
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'db.query', arguments: '{}' } }]
    }, { contextHash: 'ctx-secret', runId: 'run-secret' });
    const provider = toProviderInput([envelope]);
    assert.deepEqual(provider, [{
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'db.query', arguments: '{}' } }]
    }]);
    assert.doesNotThrow(() => assertProviderSafe(provider));
    assert.throws(() => assertProviderSafe([{ role: 'user', metadata: { contextHash: 'secret' } }]), /内部字段/);
});

test('central provider forward boundary sanitizes messages, Responses input, and tools', () => {
    const payload = normalizeProviderRequestData({
        model: 'model-a',
        messages: [{ role: 'user', content: 'hello', metadata: { credential: 'secret' } }],
        input: [{ type: 'function_call_output', call_id: 'call-1', output: 'ok', internal: 'drop' }],
        tools: [{ type: 'function', function: { name: 'echo', description: 'Echo', parameters: { type: 'object' }, metadata: 'drop' }, governance: { riskLevel: 5 } }]
    });
    assert.deepEqual(payload.messages, [{ role: 'user', content: 'hello' }]);
    assert.deepEqual(payload.input, [{ type: 'function_call_output', call_id: 'call-1', output: 'ok' }]);
    assert.deepEqual(payload.tools, [{ type: 'function', function: { name: 'echo', description: 'Echo', parameters: { type: 'object' } } }]);
});

test('tool orchestrator orders policy, checkpoint, event, and execution phases', async () => {
    const calls = [];
    const events = [];
    let replay = false;
    const orchestrator = createToolOrchestrator({
        enforceToolPolicy(args) {
            calls.push(['policy', args.input]);
            return { decision: 'allow', input: { ...args.input, normalized: true } };
        },
        async beginAgentToolCheckpoint(runId, data) {
            calls.push(['begin', runId, data.operationKey]);
            return replay ? { replay: true, output: { cached: true }, checkpointId: 'cp-1' } : { replay: false };
        },
        async completeAgentToolCheckpoint(operationKey, output) {
            calls.push(['complete', operationKey, output]);
        },
        async failAgentToolCheckpoint(operationKey, error) {
            calls.push(['fail', operationKey, error.code]);
        },
        async recordAgentEvent(event) {
            events.push(event);
        }
    });
    const request = {
        run: { id: 'run-1', user_id: 7 },
        user: { id: 7 },
        tool: { name: 'db.query', source: 'builtin', idempotent: true },
        input: { query: 'select 1' },
        context: { stepId: 'step-1', stepIndex: 1, stepContext: { turnId: 'turn-1', stepIndex: 1, contextHash: 'ctx-1' } }
    };
    const output = await orchestrator.execute({
        ...request,
        async execute({ input, operationKey, policy }) {
            calls.push(['execute', input, operationKey, policy.decision]);
            return { rows: [{ value: 1 }] };
        }
    });
    assert.deepEqual(output, { rows: [{ value: 1 }] });
    assert.deepEqual(calls.map(item => item[0]), ['policy', 'begin', 'execute', 'complete']);
    assert.deepEqual(events.map(event => event.type), ['tool.requested', 'tool.completed']);
    assert.equal(events[0].payload.contextHash, 'ctx-1');

    replay = true;
    const replayed = await orchestrator.execute({ ...request, async execute() { throw new Error('must not execute on replay'); } });
    assert.deepEqual(replayed, { cached: true });
    assert.deepEqual(calls.map(item => item[0]), ['policy', 'begin', 'execute', 'complete', 'policy', 'begin']);
    assert.deepEqual(events.map(event => event.type), ['tool.requested', 'tool.completed', 'tool.requested', 'tool.replayed']);
});

test('tool orchestrator marks failed checkpoint and emits failure event', async () => {
    const calls = [];
    const events = [];
    const orchestrator = createToolOrchestrator({
        enforceToolPolicy: () => ({ decision: 'allow', input: {} }),
        beginAgentToolCheckpoint: async () => ({ replay: false }),
        completeAgentToolCheckpoint: async () => {},
        failAgentToolCheckpoint: async (key, error) => calls.push([key, error.code]),
        recordAgentEvent: async event => events.push(event)
    });
    const error = Object.assign(new Error('tool failed'), { code: 'TOOL_FAILED' });
    await assert.rejects(() => orchestrator.execute({
        run: { id: 'run-2', user_id: 8 },
        tool: { name: 'reports.export', source: 'builtin' },
        input: {},
        context: { stepId: 'step-2' },
        execute: async () => { throw error; }
    }), error);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 'TOOL_FAILED');
    assert.equal(events.at(-1).type, 'tool.failed');
    assert.equal(events.at(-1).payload.errorCode, 'TOOL_FAILED');
});

test('tool orchestrator records policy denial before any checkpoint or handler call', async () => {
    const events = [];
    let handlerCalled = false;
    const orchestrator = createToolOrchestrator({
        enforceToolPolicy: () => {
            const error = Object.assign(new Error('denied'), { code: 'AGENT_POLICY_DENIED', category: 'policy' });
            throw error;
        },
        beginAgentToolCheckpoint: async () => { throw new Error('checkpoint must not start'); },
        recordAgentEvent: async event => events.push(event)
    });
    await assert.rejects(() => orchestrator.execute({
        run: { id: 'run-3', user_id: 9 },
        tool: { name: 'mcp.risky', source: 'mcp' },
        input: {},
        execute: async () => { handlerCalled = true; }
    }), /denied/);
    assert.equal(handlerCalled, false);
    assert.deepEqual(events.map(event => event.type), ['tool.denied']);
});
