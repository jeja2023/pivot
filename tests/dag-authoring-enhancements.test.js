const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ensureDefaults,
    getAvailableVariableOptions,
    serialize
} = require('../client/chat/dag-core');
const {
    exportDagWorkflowSpec,
    importDagWorkflowSpec,
    lintDagGraph
} = require('../client/chat/dag-governance');
const { normalizeDagSpec, inspectDagTopology } = require('../server/services/agent-validators');
const { getDagNodeRouteState } = require('../server/services/agent-dag-utils');
const { executeWorkflowTemplate } = require('../server/services/agent-tools-workflow-nodes');
const { getBuiltInToolDefinitions } = require('../server/services/agent-tools');

test('工作流变量目录包含声明输入、真实工具字段和聚合字段', () => {
    const nodes = [
        {
            id: 'order_input', tool: 'workflow.input', title: '订单编号', dependsOn: [],
            input: { name: 'orderNumber', label: '订单编号', type: 'number', required: true }
        },
        { id: 'request', tool: 'agent.http', title: '订单接口', dependsOn: ['order_input'], input: {} },
        {
            id: 'merged', tool: 'agent.merge', title: '汇总订单', dependsOn: ['request'],
            input: { fields: { order: '{{nodes.request.output.data}}' } }
        },
        { id: 'target', tool: 'workflow.template', title: '通知文案', dependsOn: ['merged'], input: {} }
    ];
    const options = getAvailableVariableOptions(nodes, 'target');
    const inputs = options.find(group => group.group === '工作流输入');
    assert.ok(inputs?.items.some(item => item.expression === '{{inputs.orderNumber}}'));
    const http = options.find(group => group.nodeId === 'request');
    assert.ok(http?.items.some(item => item.expression === '{{nodes.request.output.statusCode}}'));
    assert.ok(http?.items.some(item => item.expression === '{{nodes.request.output.data}}'));
    assert.equal(http?.items.some(item => item.expression === '{{nodes.request.output.status}}'), false);
    const merge = options.find(group => group.nodeId === 'merged');
    assert.ok(merge?.items.some(item => item.expression === '{{nodes.merged.output.merged.order}}'));
});

test('文本模板节点按缺失变量策略输出确定性结果', () => {
    assert.deepEqual(
        executeWorkflowTemplate({ template: '  日报：已完成  ', trim: true }),
        { text: '日报：已完成', charCount: 6, missingVariables: [] }
    );
    assert.deepEqual(
        executeWorkflowTemplate({ template: '日报：{{nodes.summary.output.text}}', missingVariable: 'keep' }),
        { text: '日报：{{nodes.summary.output.text}}', charCount: 32, missingVariables: ['nodes.summary.output.text'] }
    );
    assert.deepEqual(
        executeWorkflowTemplate({ template: '日报：{{nodes.summary.output.text}}', missingVariable: 'empty' }),
        { text: '日报：', charCount: 3, missingVariables: [] }
    );
    assert.throws(
        () => executeWorkflowTemplate({ template: '{{inputs.title}}', missingVariable: 'error' }),
        /未解析变量/
    );
    assert.deepEqual(
        executeWorkflowTemplate({ template: { title: '日报', count: 2 }, trim: false }),
        { text: '{\n  "title": "日报",\n  "count": 2\n}', charCount: 33, missingVariables: [] }
    );
});

test('True/False 路由边兼容旧 dependsOn 并按条件输出激活', () => {
    const source = {
        schemaVersion: 'pivot.dag.v2',
        nodes: [
            { id: 'condition', tool: 'workflow.condition', dependsOn: [] },
            { id: 'yes', tool: 'workflow.template', dependsOn: [] },
            { id: 'no', tool: 'workflow.template', dependsOn: [] }
        ],
        edges: [
            { from: 'condition', to: 'yes', route: 'true' },
            { from: 'condition', to: 'no', route: 'false' }
        ]
    };
    const normalized = normalizeDagSpec(source);
    assert.deepEqual(normalized.nodes.find(node => node.id === 'yes').dependsOn, ['condition']);
    assert.deepEqual(normalized.nodes.find(node => node.id === 'no').dependsOn, ['condition']);
    assert.equal(inspectDagTopology(normalized).blockers.length, 0);

    const trueStates = new Map([['condition', { status: 'completed', output: { matched: true } }]]);
    assert.equal(getDagNodeRouteState(normalized.nodes.find(node => node.id === 'yes'), normalized, trueStates).active, true);
    assert.equal(getDagNodeRouteState(normalized.nodes.find(node => node.id === 'no'), normalized, trueStates).active, false);
    const falseStates = new Map([['condition', { status: 'completed', output: { matched: false } }]]);
    assert.equal(getDagNodeRouteState(normalized.nodes.find(node => node.id === 'yes'), normalized, falseStates).active, false);
    assert.equal(getDagNodeRouteState(normalized.nodes.find(node => node.id === 'no'), normalized, falseStates).active, true);
    const failedCondition = new Map([['condition', { status: 'continued_error', output: { error: '条件执行失败' } }]]);
    assert.equal(getDagNodeRouteState(normalized.nodes.find(node => node.id === 'no'), normalized, failedCondition).active, false);

    const legacy = normalizeDagSpec({ nodes: [{ id: 'start', tool: 'workflow.template', dependsOn: [] }, { id: 'end', tool: 'workflow.template', dependsOn: ['start'] }] });
    assert.equal(Object.hasOwn(legacy, 'edges'), false);
    assert.deepEqual(legacy.nodes.find(node => node.id === 'end').dependsOn, ['start']);
});

test('路由边会经过编辑期序列化、导入导出和静态治理', () => {
    const draft = ensureDefaults({
        schemaVersion: 'pivot.dag.v2',
        nodes: [
            { id: 'condition', tool: 'workflow.condition', dependsOn: [] },
            { id: 'yes', tool: 'workflow.template', dependsOn: ['condition'] }
        ],
        edges: [{ from: 'condition', to: 'yes', route: 'true' }]
    });
    const serialized = serialize(draft);
    assert.equal(serialized.schemaVersion, 'pivot.dag.v2');
    assert.deepEqual(serialized.edges, [{ from: 'condition', to: 'yes', route: 'true' }]);
    const exported = exportDagWorkflowSpec(serialized, { name: '路由测试' });
    assert.equal(exported.schemaVersion, 'pivot.dag.v2');
    assert.deepEqual(exported.spec.edges, [{ from: 'condition', to: 'yes', route: 'true' }]);
    const imported = importDagWorkflowSpec(JSON.stringify(exported));
    assert.equal(imported.ok, true);
    assert.deepEqual(imported.spec.edges, [{ from: 'condition', to: 'yes', route: 'true' }]);
    const invalid = lintDagGraph({
        nodes: draft.nodes,
        edges: [{ from: 'yes', to: 'condition', route: 'true' }]
    });
    assert.equal(invalid.valid, false);
    assert.ok(invalid.errors.some(item => item.type === 'invalid_route_source'));
});

test('文本模板作为受治理的内置工具公开输入与输出契约', () => {
    const tool = getBuiltInToolDefinitions({ id: 1 }).find(item => item.name === 'workflow.template');
    assert.ok(tool);
    assert.deepEqual(tool.input_schema.required, ['template']);
    assert.equal(tool.output_schema.properties.text.type, 'string');
});
