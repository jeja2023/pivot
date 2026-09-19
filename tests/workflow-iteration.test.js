const test = require('node:test');
const assert = require('node:assert/strict');

const { executeWorkflowIteration } = require('../server/services/agent-dag-runtime');

function makeDeps() {
    const invocations = new Map();
    const nodes = new Map();
    return {
        invocations,
        nodes,
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
        parentContext: { dagInputs: {}, states: new Map(), nodeMap: new Map(), callerNodeId: 'iterate' }
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
