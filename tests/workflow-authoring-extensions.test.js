const test = require('node:test');
const assert = require('node:assert/strict');

const {
    executeWorkflowTemplate,
    executeWorkflowInput,
    executeWorkflowCondition
} = require('../server/services/agent-tools-workflow-nodes');
const { getDagNodeRouteState, evaluateDagWhen } = require('../server/services/agent-dag-utils');
const { normalizeDagSpec, inspectDagTopology } = require('../server/services/agent-validators');
const { getBuiltInToolDefinitions } = require('../server/services/agent-tools');
const { BUILTIN_TOOL_CAPABILITIES } = require('../server/services/agent-tool-capabilities');
const { getAvailableVariableOptions } = require('../client/chat/dag-core');
const { lintDagGraph, exportDagWorkflowSpec, importDagWorkflowSpec } = require('../client/chat/dag-governance');

test('workflow.template renders deterministic text and reports missing variables', () => {
    assert.deepEqual(
        executeWorkflowTemplate({ template: '  Hello {{name}}  ', trim: true, missingVariable: 'keep' }),
        { text: 'Hello {{name}}', charCount: 14, missingVariables: ['name'] }
    );
    assert.equal(executeWorkflowTemplate({ template: 'Hello {{name}}', missingVariable: 'empty' }).text, 'Hello');
    assert.throws(() => executeWorkflowTemplate({ template: 'Hello {{name}}', missingVariable: 'error' }), /未解析变量/);
});

test('workflow input and condition outputs expose stable fields for routing', () => {
    const input = executeWorkflowInput({ name: 'orderNumber', label: '订单号', type: 'number' }, { dagInputs: { orderNumber: '12' } });
    assert.equal(input.value, 12);
    assert.equal(input.text, '12');
    const condition = executeWorkflowCondition({ value: true, operator: 'is_true' });
    assert.equal(condition.matched, true);
    assert.equal(condition.route, 'matched');
});

test('DAG edge routes normalize into legacy dependsOn without losing route metadata', () => {
    const spec = normalizeDagSpec({
        schemaVersion: 'pivot.dag.v2',
        nodes: [
            { id: 'condition', tool: 'workflow.condition' },
            { id: 'yes', tool: 'workflow.template' },
            { id: 'no', tool: 'workflow.template' }
        ],
        edges: [
            { from: 'condition', to: 'yes', route: 'true' },
            { from: 'condition', to: 'no', route: 'false' }
        ]
    });
    assert.deepEqual(spec.nodes.find(node => node.id === 'yes').dependsOn, ['condition']);
    assert.deepEqual(spec.nodes.find(node => node.id === 'no').dependsOn, ['condition']);
    assert.equal(inspectDagTopology(spec).blockers.length, 0);

    const states = new Map([['condition', { status: 'completed', output: { matched: true } }]]);
    assert.equal(getDagNodeRouteState(spec.nodes.find(node => node.id === 'yes'), spec, states).active, true);
    assert.equal(getDagNodeRouteState(spec.nodes.find(node => node.id === 'no'), spec, states).active, false);
});

test('edge route topology rejects ambiguous true and false routes', () => {
    const spec = normalizeDagSpec({
        schemaVersion: 'pivot.dag.v2',
        nodes: [
            { id: 'condition', tool: 'workflow.condition' },
            { id: 'target', tool: 'workflow.template' }
        ],
        edges: [
            { from: 'condition', to: 'target', route: 'true' },
            { from: 'condition', to: 'target', route: 'false' }
        ]
    });
    assert.ok(inspectDagTopology(spec).blockers.some(message => /True 和 False/.test(message)));
});

test('variable options include workflow inputs and corrected built-in output fields', () => {
    const nodes = [
        { id: 'input', title: '订单号', tool: 'workflow.input', input: { name: 'orderNumber', label: '订单号', type: 'number' }, dependsOn: [] },
        { id: 'http', title: '接口', tool: 'agent.http', dependsOn: ['input'] },
        { id: 'merge', title: '聚合', tool: 'agent.merge', dependsOn: ['http'] }
    ];
    const options = getAvailableVariableOptions(nodes, 'merge', []);
    const globalInput = options.find(group => group.group === '工作流输入');
    assert.ok(globalInput.items.some(item => item.expression === '{{inputs.orderNumber}}'));
    const http = options.find(group => group.nodeId === 'http');
    assert.ok(http.items.some(item => item.expression === '{{nodes.http.output.statusCode}}'));
    assert.ok(http.items.some(item => item.expression === '{{nodes.http.output.data}}'));
});

test('workflow template is registered with capability governance and export/import preserve edges', () => {
    const definitions = getBuiltInToolDefinitions({ id: 1 });
    const template = definitions.find(tool => tool.name === 'workflow.template');
    assert.ok(template);
    assert.deepEqual(BUILTIN_TOOL_CAPABILITIES['workflow.template'], ['workflow.control']);
    const exported = exportDagWorkflowSpec({
        nodes: [
            { id: 'c', title: '条件', tool: 'workflow.condition', dependsOn: [] },
            { id: 't', title: '真', tool: 'workflow.template', dependsOn: ['c'] }
        ],
        edges: [{ from: 'c', to: 't', route: 'true' }]
    });
    assert.equal(exported.schemaVersion, 'pivot.dag.v2');
    const imported = importDagWorkflowSpec(JSON.stringify(exported));
    assert.equal(imported.ok, true);
    assert.deepEqual(imported.spec.edges, [{ from: 'c', to: 't', route: 'true' }]);
});

test('client governance checks route edges and when evaluation remains compatible', () => {
    const graph = {
        nodes: [
            { id: 'c', title: '条件', tool: 'workflow.condition', dependsOn: [] },
            { id: 't', title: '真', tool: 'workflow.template', dependsOn: ['c'] }
        ],
        edges: [{ from: 'c', to: 't', route: 'true' }]
    };
    assert.equal(lintDagGraph(graph).valid, true);
    const states = new Map([['c', { status: 'completed', output: { matched: true } }]]);
    const result = evaluateDagWhen({ source: 'nodes.c.output.matched', operator: 'is_true' }, { states, nodeMap: new Map([['c', { id: 'c' }]]) });
    assert.equal(result.skipped, false);
});
