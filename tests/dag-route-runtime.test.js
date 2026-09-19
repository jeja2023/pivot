const test = require('node:test');
const assert = require('node:assert/strict');

const { runAgentDag } = require('../server/services/agent-dag-runtime');

function runRoutedWorkflow(matched, { joinMode = '' } = {}) {
    const persisted = new Map();
    const steps = [];
    const updates = [];
    const tools = [
        { name: 'workflow.condition', input_schema: { type: 'object', properties: { value: {} } } },
        { name: 'workflow.template', input_schema: { type: 'object', properties: { template: { type: 'string' } }, required: ['template'] } }
    ];
    const dagSpec = {
        schemaVersion: 'pivot.dag.v2',
        nodes: [
            { id: 'condition', title: '判断', tool: 'workflow.condition', input: { value: matched }, dependsOn: [] },
            { id: 'yes', title: '满足分支', tool: 'workflow.template', input: { template: 'yes' }, dependsOn: ['condition'] },
            { id: 'no', title: '不满足分支', tool: 'workflow.template', input: { template: 'no' }, dependsOn: ['condition'] },
            ...(joinMode ? [{ id: 'join', title: '汇聚', tool: 'workflow.template', input: { template: 'joined' }, dependsOn: ['yes', 'no'], joinMode }] : [])
        ],
        edges: [
            { from: 'condition', to: 'yes', route: 'true' },
            { from: 'condition', to: 'no', route: 'false' },
            ...(joinMode ? [{ from: 'yes', to: 'join', route: 'default' }, { from: 'no', to: 'join', route: 'default' }] : [])
        ]
    };
    const run = { id: `route-${matched}`, goal: '路由测试', metadata: { dagSpec }, tool_timeout_ms: 30000 };
    const deps = {
        getRunMetadata: value => value.metadata,
        listDagNodes: async () => [...persisted.values()],
        listSteps: async () => steps,
        upsertDagNode: async (_runId, node, patch) => {
            const previous = persisted.get(node.id) || { node_key: node.id };
            persisted.set(node.id, { ...previous, ...patch, node_key: node.id, tool_name: node.tool, title: node.title });
        },
        assertRunNotCancelled: async () => {},
        assertRunWithinBudget: () => {},
        insertStep: async (_runId, index, step) => { steps.push({ step_index: index, ...step }); },
        updateRun: async (_runId, patch) => { updates.push(patch); },
        createAgentNotification: async () => {},
        getAgentRunTitle: () => '路由测试',
        dagNodeConcurrency: 4,
        agentToolTimeoutMs: 30000,
        maybePauseForApproval: async () => false,
        isApprovalGranted: () => false,
        withTimeout: async operation => operation(new AbortController().signal),
        recordAgentToolCall: async () => {},
        executeToolByName: async (name, input) => {
            if (name === 'workflow.condition') return { matched: Boolean(input.value), route: input.value ? 'matched' : 'unmatched', text: input.value ? 'matched' : 'unmatched' };
            if (name === 'workflow.template') return { text: input.template, charCount: input.template.length, missingVariables: [] };
            throw new Error(`未预期的工具：${name}`);
        }
    };
    return runAgentDag({ run, user: { id: 1 }, modelCfg: null, toolList: tools, deadline: Date.now() + 30000, assertRunWithinBudget: () => {} }, deps)
        .then(() => ({ persisted, updates, steps }));
}

test('DAG 运行时只执行 True/False 路由中被激活的一侧', async () => {
    const trueRun = await runRoutedWorkflow(true);
    assert.equal(trueRun.persisted.get('condition').status, 'completed');
    assert.equal(trueRun.persisted.get('yes').status, 'completed');
    assert.equal(trueRun.persisted.get('no').status, 'skipped');
    assert.equal(trueRun.persisted.get('no').output.reason, 'route_not_matched');
    assert.deepEqual(trueRun.persisted.get('no').output.routeSource, ['condition']);
    assert.equal(trueRun.updates.at(-1).status, 'completed');

    const falseRun = await runRoutedWorkflow(false);
    assert.equal(falseRun.persisted.get('yes').status, 'skipped');
    assert.equal(falseRun.persisted.get('no').status, 'completed');
    assert.equal(falseRun.persisted.get('yes').output.reason, 'route_not_matched');
});

test('显式任一激活分支汇聚忽略路由未命中的 skipped 依赖', async () => {
    const trueRun = await runRoutedWorkflow(true, { joinMode: 'any_active' });
    assert.equal(trueRun.persisted.get('yes').status, 'completed');
    assert.equal(trueRun.persisted.get('no').status, 'skipped');
    assert.equal(trueRun.persisted.get('join').status, 'completed');

    const falseRun = await runRoutedWorkflow(false, { joinMode: 'any_active' });
    assert.equal(falseRun.persisted.get('yes').status, 'skipped');
    assert.equal(falseRun.persisted.get('no').status, 'completed');
    assert.equal(falseRun.persisted.get('join').status, 'completed');
});
