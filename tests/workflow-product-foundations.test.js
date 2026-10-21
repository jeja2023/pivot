const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const definition = require('../client/chat/dag-definition');
const core = require('../client/chat/dag-core');
const { resolveDagNodeInput } = require('../server/services/agent-dag-utils');
const { normalizeDagSpec } = require('../server/services/agent-validators');
const { coerceWorkflowInput } = require('../server/services/agent-tools-workflow-nodes');
const source = name => fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');

test('复制子图只改写内部数据和条件引用，保留外部数据与普通说明', () => {
    const nodes = [{ id: 'a', tool: 'workflow.template', input: { template: 'A' } }, { id: 'b', dependsOn: ['a', 'outside'], input: {
        text: '{{nodes.a.output.text}} / {{nodes.outside.output}}', nested: [{ value: '{{node.a.output.text}}' }], explanation: 'nodes.a.output.text'
    }, when: { source: 'nodes.a.output.text', operator: 'not_empty' } }];
    const copied = definition.cloneSelection(nodes, new Map([['a', 'copy_a'], ['b', 'copy_b']]));
    assert.deepEqual(copied[1].dependsOn, ['copy_a', 'outside']);
    assert.equal(copied[1].input.text, '{{nodes.copy_a.output.text}} / {{nodes.outside.output}}');
    assert.equal(copied[1].input.nested[0].value, '{{node.copy_a.output.text}}');
    assert.equal(copied[1].when.source, 'nodes.copy_a.output.text');
    assert.equal(copied[1].input.explanation, 'nodes.a.output.text');
    assert.equal(nodes[1].when.source, 'nodes.a.output.text');
});

test('节点测试只使配置变化节点及下游失效，布局和其他支线保持有效', () => {
    core.resetDagNodeTestSession();
    const spec = { nodes: [{ id: 'a', tool: 'workflow.template', input: { template: 'A' } }, { id: 'b', tool: 'workflow.template', input: {}, dependsOn: ['a'] }, { id: 'other', tool: 'workflow.template', input: {} }], layout: { a: { x: 0, y: 0 } } };
    core.setDagNodeTestContext(spec, { flag: false });
    for (const node of spec.nodes) core.setDagNodeTestOutput(node.id, { output: { text: node.id } });
    spec.layout.a.x = 20;
    core.setDagNodeTestContext(spec, { flag: false });
    assert.equal(core.getNodeTestOutputSnapshots().size, 3);
    spec.nodes[0].input.template = 'changed';
    core.setDagNodeTestContext(spec, { flag: false });
    assert.deepEqual([...core.getNodeTestOutputSnapshots().keys()], ['other']);
    core.setDagNodeTestContext(spec, { flag: true });
    assert.equal(core.getNodeTestOutputSnapshots().size, 0);
});

test('迟到响应与重复测试不能将旧结果写到新配置或新编辑会话', () => {
    const spec = { nodes: [{ id: 'a', tool: 'workflow.template', input: { template: 'old' } }] };
    core.resetDagNodeTestSession();
    const first = core.beginDagNodeTest('a', spec);
    const second = core.beginDagNodeTest('a', spec);
    assert.equal(core.isDagNodeTestCurrent('a', first, spec), false);
    assert.equal(core.isDagNodeTestCurrent('a', second, spec), true);
    spec.nodes[0].input.template = 'new';
    assert.equal(core.isDagNodeTestCurrent('a', second, spec), false);
    const third = core.beginDagNodeTest('a', spec);
    core.resetDagNodeTestSession();
    assert.equal(core.isDagNodeTestCurrent('a', third, spec), false);
});

test('真实节点测试控制器拒收配置变更后的旧网络响应', async () => {
    core.resetDagNodeTestSession();
    let release;
    const response = new Promise(resolve => { release = resolve; });
    let controllerApi;
    const button = { setAttribute() {} }; const result = {};
    const ctx = { spec: { nodes: [{ id: 'a', tool: 'workflow.template', input: { template: 'old' } }] }, getDagInputs: () => ({}) };
    const sandbox = { AbortController, window: { Pivot: { moduleApi: () => core, registerModule: (_name, api) => { controllerApi = api; } } }, apiFetch: () => response };
    vm.runInNewContext(source('client/chat/dag-inspector-testing.js'), sandbox);
    const controls = controllerApi.createDagNodeTestController({ inspector: { querySelector: selector => selector.includes('test-node]') ? button : selector.includes('test-input]') ? null : result },
        ctx, getUpstreamNodes: () => [], getRunStates: () => new Map(), getNodeTestOutputSnapshots: core.getNodeTestOutputSnapshots,
        setDagNodeTestOutput: core.setDagNodeTestOutput, snapshotValue: value => value, apiBase: '/api' });
    const pending = controls.testNode(ctx.spec.nodes[0]);
    ctx.spec.nodes[0].input.template = 'new';
    release({ ok: true, json: async () => ({ output: { text: 'old result' } }) });
    await pending;
    assert.equal(core.getNodeTestOutputSnapshots().size, 0);
});

test('变量路径预检和运行错误包含字段位置，0、false及默认值不误判', () => {
    const spec = { nodes: [{ id: 'a', tool: 'source', outputSchema: { type: 'object', properties: { amount: { type: 'number' }, flag: { type: 'boolean' } } } }, { id: 'b', title: '分析', input: { prompt: '{{nodes.a.output.typo}}' } }] };
    const issues = definition.inspectReferences(spec);
    assert.equal(issues[0].path, 'prompt');
    const context = { strictReferences: true, inputs: {}, states: new Map([['a', { output: { amount: 0, flag: false } }]]), nodeMap: new Map(spec.nodes.map(node => [node.id, node])) };
    assert.throws(() => resolveDagNodeInput(spec.nodes[1], context), error => error.code === 'DAG_UNRESOLVED_REFERENCE' && error.details.references[0].path === 'prompt');
    assert.deepEqual(resolveDagNodeInput({ input: { zero: '{{nodes.a.output.amount}}', flag: '{{nodes.a.output.flag}}', fallback: '{{inputs.absent ?? "备用"}}', optional: '{{?inputs.absent}}' } }, context), { zero: 0, flag: false, fallback: '备用', optional: null });
});

test('分组完整往返并保持结构规范', () => {
    const spec = { nodes: [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['a'] }, { id: 'join', dependsOn: ['b', 'c'] }], groups: [{ id: 'g', title: '分支', nodeIds: ['b', 'c'], collapsed: true }] };
    assert.deepEqual(core.serialize(core.ensureDefaults(spec)).groups, spec.groups);
    assert.deepEqual(normalizeDagSpec(spec).groups, spec.groups);
});

test('工作流日期和文件参数校验类型并保留有效值', () => {
    assert.equal(coerceWorkflowInput('2026-10-20', 'date', 'date'), '2026-10-20');
    assert.throws(() => coerceWorkflowInput('2026-02-31', 'date', 'date'));
    assert.throws(() => coerceWorkflowInput('not-date', 'date', 'date'));
    const file = { name: '资料.pdf', url: '/uploads/1/session/material.pdf?token=abc' };
    assert.deepEqual(coerceWorkflowInput(file, 'file', 'file'), file);
    assert.throws(() => coerceWorkflowInput({ name: 'x', url: 'file:///secret' }, 'file', 'file'));
});

test('三个业务模板使用真实工具结构，参数与运行输出引用保持一致', () => {
    let templates;
    vm.runInNewContext(source('client/chat/workflow-product-templates.js'), { window: { Pivot: { registerModule: (_name, api) => { templates = api; } } } });
    assert.equal(templates.templates.length, 3);
    for (const item of templates.templates) {
        const instantiated = templates.instantiate(item.id, 7);
        const spec = normalizeDagSpec(instantiated.spec);
        assert.ok(spec.nodes.find(node => ['agent.llm', 'agent.content_review'].includes(node.tool)).input.model);
        assert.ok(spec.nodes.every(node => node.tool));
    }
});
