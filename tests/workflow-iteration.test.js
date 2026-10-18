const test = require('node:test');
const assert = require('node:assert/strict');

const { executeWorkflowIteration } = require('../server/services/agent-dag-runtime');
const { createSubworkflowRuntime } = require('../server/services/agent-dag-subworkflow-runtime');

function makeDeps() {
    const invocations = new Map();
    const nodes = new Map();
    const iterationItems = new Map();
    return {
        invocations,
        nodes,
        iterationItems,
        async assertRunNotCancelled() {},
        async listDagNodes() { return [...nodes.values()]; },
        async upsertDagNode(_runId, node, patch) {
            const key = patch.nodeKey || node.id;
            const previous = nodes.get(key) || { node_key: key };
            nodes.set(key, { ...previous, ...patch, node_key: key });
        },
        async upsertSubworkflowInvocation(payload) { invocations.set(payload.invocationId, { ...payload }); },
        async getSubworkflowInvocation(_runId, executionPath) {
            return [...invocations.values()].find(item => item.executionPath === executionPath) || null;
        },
        async listWorkflowIterationItems(runId, iterationKey) {
            return [...iterationItems.values()].filter(item => item.runId === runId && item.iterationKey === iterationKey);
        },
        async upsertWorkflowIterationItem(payload) {
            iterationItems.set(`${payload.runId}:${payload.iterationKey}:${payload.inputIndex}`, { ...payload, input_index: payload.inputIndex, input_digest: payload.inputDigest, result_json: payload.result });
        },
        async resolveAgentWorkflowVersion(workflowId, _user, version) {
            return {
                workflow: { id: workflowId, name: `子流程${workflowId}` },
                version: Number(version) || 7,
                version_id: 70,
                dagSpec: {
                    nodes: [{ id: 'output', title: '输出', tool: 'workflow.output', input: { name: 'result', value: '{{inputs.item.name}}' }, dependsOn: [] }]
                }
            };
        },
        async resolveAgentWorkflowDependencyBindings(resolved) { return resolved; },
        async executeToolByName(name, input) {
            if (name === 'workflow.output') return { name: input.name, value: input.value, text: String(input.value), presentation: 'default' };
            throw new Error(`未预期工具：${name}`);
        },
        async withTimeout(operation) { return await operation(new AbortController().signal); },
        async recordAgentToolCall() {},
        async insertStep() {},
        async listSteps() { return []; },
        async waitForDagRetry() {},
        async maybePauseForApproval() { return false; },
        isApprovalGranted() { return false; },
        agentToolTimeoutMs: 30000,
        taskBudget: { consumeStep() {} }
    };
}

test('逐项调用子工作流保留顺序、调用身份和固定版本', async () => {
    const deps = makeDeps();
    const executeTool = deps.executeToolByName;
    const contexts = [];
    deps.executeToolByName = async (name, input, user, tools, context) => { contexts.push(context); return await executeTool(name, input, user, tools, context); };
    const result = await executeWorkflowIteration({
        input: {
            items: [{ name: '甲' }, { name: '乙' }],
            workflowId: 10,
            version: '7',
            inputs: { item: '{{item}}', itemIndex: '{{itemIndex}}' },
            concurrency: 2,
            onItemError: 'continue'
        },
        run: { id: 'iteration-run', goal: '逐项测试', tool_timeout_ms: 30000 },
        user: { id: 1 },
        modelCfg: null,
        toolList: [{ name: 'workflow.output', input_schema: { type: 'object' } }],
        deadline: Date.now() + 30000,
        deps,
        parentContext: { dagInputs: {}, states: new Map(), nodeMap: new Map(), callerNodeId: 'iterate', taskTransactionId: 'tx-iteration' }
    });
    assert.equal(result.inputCount, 2);
    assert.equal(result.count, 2);
    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.items.map(item => item.value), ['甲', '乙']);
    assert.deepEqual(result.items.map(item => item.inputIndex), [0, 1]);
    assert.equal(new Set(result.items.map(item => item.invocationId)).size, 2);
    assert.equal([...deps.invocations.values()].every(item => item.workflowVersion === 7 && item.workflowVersionId === 70), true);
    assert.equal([...deps.nodes.values()].some(item => String(item.node_key).includes('item:0')), true);
    assert.equal([...deps.nodes.values()].some(item => String(item.node_key).includes('item:1')), true);
    assert.equal([...deps.iterationItems.values()].every(item => item.inputDigest && item.itemId), true);
    assert.equal(contexts.every(context => context.taskTransactionId === 'tx-iteration'), true);
});

test('嵌套子工作流继承同一任务事务与取消信号', async () => {
    const deps = makeDeps();
    deps.resolveAgentWorkflowVersion = async workflowId => ({
        workflow: { id: workflowId, name: `子流程${workflowId}` }, version: 1, version_id: workflowId * 10,
        dagSpec: { nodes: [{ id: 'node', tool: workflowId === 10 ? 'workflow.subworkflow' : 'workflow.output', input: {}, dependsOn: [] }] }
    });
    const seen = [];
    const runtime = createSubworkflowRuntime({
        executeDagNodeWithPolicy: async ({ node, executionContext }) => {
            seen.push(executionContext);
            if (node.tool === 'workflow.subworkflow') await executionContext.executeSubworkflow({ workflowId: 11 });
            return { ok: true, output: { name: 'result', value: '完成' }, attempt: 1, durationMs: 1 };
        },
        buildDagErrorInfo: () => ({}), prepareDagFallbackOutput: () => null,
        buildDagFallbackFinalAnswer: () => '', extractReadableDagOutput: () => '', upsertDagNode: deps.upsertDagNode
    });
    const signal = new AbortController().signal;
    await runtime.executeSubworkflowDag({
        input: { workflowId: 10 }, run: { id: 'nested-transaction', goal: '测试' }, user: { id: 1 }, modelCfg: null,
        toolList: [{ name: 'workflow.subworkflow' }, { name: 'workflow.output' }], deadline: Date.now() + 30000,
        deps, taskTransactionId: 'tx-parent', signal
    });
    assert.equal(seen.length, 2);
    assert.equal(seen.every(context => context.taskTransactionId === 'tx-parent' && context.signal === signal), true);
});

test('子工作流在执行前拒绝无效输入并拒绝不符合契约的输出', async () => {
    for (const mode of ['input', 'output']) {
        const deps = makeDeps();
        let calls = 0;
        deps.resolveAgentWorkflowVersion = async workflowId => ({
            workflow: { id: workflowId, name: '契约测试' }, version: 1, version_id: 10,
            dagSpec: { nodes: [{ id: 'node', tool: 'workflow.output', input: { value: '文本' }, dependsOn: [],
                inputSchema: mode === 'input' ? { type: 'object', properties: { value: { type: 'number' } } } : {},
                outputSchema: mode === 'output' ? { type: 'object', required: ['result'] } : {} }] }
        });
        const runtime = createSubworkflowRuntime({
            executeDagNodeWithPolicy: async () => { calls += 1; return { ok: true, output: { wrong: true }, attempt: 1, durationMs: 1 }; },
            buildDagErrorInfo: error => ({ code: error.code }), prepareDagFallbackOutput: () => null,
            buildDagFallbackFinalAnswer: () => '', extractReadableDagOutput: () => '', upsertDagNode: deps.upsertDagNode
        });
        await assert.rejects(() => runtime.executeSubworkflowDag({
            input: { workflowId: 10 }, run: { id: `contract-${mode}`, goal: '测试' }, user: { id: 1 }, modelCfg: null,
            toolList: [{ name: 'workflow.output' }], deadline: Date.now() + 30000, deps
        }), error => error.code === 'AGENT_SUBWORKFLOW_NODE_FAILED');
        assert.equal(calls, mode === 'input' ? 0 : 1);
        const node = [...deps.nodes.values()].find(item => item.status === 'error');
        assert.equal(node.contractStatus, 'invalid');
        assert.ok(node.contractIssues.length > 0);
    }
});

test('预览模式阻断子工作流中的副作用及审批节点，即使节点配置为失败后继续', async () => {
    for (const marker of ['side_effect', 'sideEffect', 'approval_required', 'approvalRequired', 'requiresApproval', 'alwaysRequiresApproval']) {
        const deps = makeDeps();
        let calls = 0;
        deps.resolveAgentWorkflowVersion = async workflowId => ({
            workflow: { id: workflowId, name: '预览子工作流' }, version: 1, version_id: 10,
            dagSpec: { nodes: [{ id: 'write', tool: 'custom.action', input: {}, dependsOn: [], onError: 'continue' }] }
        });
        const runtime = createSubworkflowRuntime({
            executeDagNodeWithPolicy: async () => { calls += 1; return { ok: true, output: {} }; },
            buildDagErrorInfo: () => ({}), prepareDagFallbackOutput: () => null,
            buildDagFallbackFinalAnswer: () => '', extractReadableDagOutput: () => '', upsertDagNode: deps.upsertDagNode
        });
        await assert.rejects(() => runtime.executeSubworkflowDag({
            input: { workflowId: 10 }, run: { id: `preview-${marker}`, metadata: JSON.stringify({ workflow_run_source: 'preview' }) },
            user: { id: 1 }, modelCfg: null, toolList: [{ name: 'custom.action', [marker]: true }],
            deadline: Date.now() + 30000, deps
        }), error => error.code === 'AGENT_PREVIEW_SIDE_EFFECT_BLOCKED');
        assert.equal(calls, 0);
    }
});

test('逐项子工作流检查不同字段命名的副作用及审批声明', async () => {
    for (const marker of ['side_effect', 'sideEffect', 'approval_required', 'approvalRequired', 'requiresApproval', 'alwaysRequiresApproval']) {
        const deps = makeDeps();
        let calls = 0;
        deps.executeToolByName = async () => { calls += 1; return {}; };
        const result = await executeWorkflowIteration({
            input: { items: [{ name: '甲' }], workflowId: 10 },
            run: { id: `iteration-${marker}`, goal: '测试' }, user: { id: 1 }, modelCfg: null,
            toolList: [{ name: 'workflow.output', [marker]: true }], deadline: Date.now() + 30000, deps,
            parentContext: { dagInputs: {}, states: new Map(), nodeMap: new Map(), callerNodeId: 'iterate' }
        });
        assert.equal(result.errors.length, 1);
        assert.match(result.errors[0].error, /不支持副作用、审批/);
        assert.equal(calls, 0);
    }
});

test('逐项调用子工作流按 continue 和 drop 处理失败项', async () => {
    const deps = makeDeps();
    const original = deps.resolveAgentWorkflowVersion;
    deps.resolveAgentWorkflowVersion = async (workflowId, user, version) => {
        const value = await original(workflowId, user, version);
        value.dagSpec.nodes[0].input.value = '{{inputs.item.value}}';
        return value;
    };
    const originalExecute = deps.executeToolByName;
    deps.executeToolByName = async (name, input) => {
        if (input.value === '坏') throw new Error('故意失败');
        return originalExecute(name, input);
    };
    const base = {
        items: [{ value: '好' }, { value: '坏' }, { value: '好2' }], workflowId: 10, version: '7',
        inputs: { item: '{{item}}' }, concurrency: 2
    };
    const common = {
        run: { id: 'iteration-errors', goal: '逐项测试', tool_timeout_ms: 30000 }, user: { id: 1 }, modelCfg: null,
        toolList: [{ name: 'workflow.output', input_schema: { type: 'object' } }], deadline: Date.now() + 30000,
        deps, parentContext: { dagInputs: {}, states: new Map(), nodeMap: new Map(), callerNodeId: 'iterate' }
    };
    const continued = await executeWorkflowIteration({ input: { ...base, onItemError: 'continue' }, ...common });
    assert.equal(continued.count, 3);
    assert.equal(continued.errors.length, 1, JSON.stringify(continued));
    assert.equal(continued.items[1].status, 'error');
    const dropped = await executeWorkflowIteration({ input: { ...base, onItemError: 'drop' }, ...common });
    assert.equal(dropped.count, 2);
    assert.deepEqual(dropped.items.map(item => item.inputIndex), [0, 2]);
});

test('逐项恢复仅复用输入摘要未变化的已完成项', async () => {
    const deps = makeDeps();
    const base = {
        items: [{ name: '甲' }, { name: '乙' }], workflowId: 10, version: '7',
        inputs: { item: '{{item}}' }, concurrency: 1, onItemError: 'continue'
    };
    const common = {
        run: { id: 'iteration-resume', goal: '逐项恢复', tool_timeout_ms: 30000 }, user: { id: 1 }, modelCfg: null,
        toolList: [{ name: 'workflow.output', input_schema: { type: 'object' } }], deadline: Date.now() + 30000,
        deps, parentContext: { dagInputs: {}, states: new Map(), nodeMap: new Map(), callerNodeId: 'iterate' }
    };
    await executeWorkflowIteration({ input: base, ...common });
    const firstInvocationCount = deps.invocations.size;
    const resumed = await executeWorkflowIteration({ input: base, ...common });
    assert.equal(resumed.items.every(item => item.reused === true), true);
    assert.equal(deps.invocations.size, firstInvocationCount);
    const changed = await executeWorkflowIteration({ input: { ...base, items: [{ name: '甲' }, { name: '新乙' }] }, ...common });
    assert.equal(changed.items[0].reused, true);
    assert.equal(changed.items[1].reused, undefined);
});
