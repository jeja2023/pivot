const test = require('node:test');
const assert = require('node:assert/strict');

const { createRunLifecycle } = require('../server/services/agent-runtime/run-lifecycle');
const { normalizeDagSpec } = require('../server/services/agent-validators');

test('节点重跑保留完整工作流图、路由边与可解释的复用来源', async () => {
    const dagSpec = {
        schemaVersion: 'pivot.dag.v2',
        cacheEnabled: false,
        layout: { gate: { x: 1, y: 1 }, source: { x: 2, y: 2 }, retry: { x: 3, y: 3 }, other: { x: 3, y: 4 } },
        nodes: [
            { id: 'gate', tool: 'workflow.condition', dependsOn: [] },
            { id: 'source', tool: 'workflow.template', dependsOn: ['gate'] },
            { id: 'retry', tool: 'workflow.template', dependsOn: ['source'], retryLimit: 2, cache: false },
            { id: 'other', tool: 'workflow.template', dependsOn: ['gate'] }
        ],
        edges: [
            { from: 'gate', to: 'source', route: 'true' },
            { from: 'source', to: 'retry', route: 'default' },
            { from: 'gate', to: 'other', route: 'false' }
        ]
    };
    const lifecycle = createRunLifecycle({
        getRunMetadata: run => run.metadata,
        normalizeDagSpec,
        listDagNodes: async () => [
            { node_key: 'gate', status: 'completed', input: {}, output: { matched: true } },
            // 截断输出不能被重跑计划直接复用，因此 source 必须被加入执行范围。
            { node_key: 'source', status: 'completed', input: {}, output: { __partial: true, text: 'preview' } },
            { node_key: 'retry', status: 'error', input: {}, output: null, error_message: 'temporary error' },
            { node_key: 'other', status: 'skipped', input: {}, output: { status: 'skipped', reason: 'route_not_matched' } }
        ]
    });

    const plan = await lifecycle.buildDagResumeSpec({ id: 'original-run', metadata: { dagSpec } }, 'retry');
    assert.equal(plan.dagSpec.schemaVersion, 'pivot.dag.v2');
    assert.equal(plan.dagSpec.cacheEnabled, false);
    assert.deepEqual(plan.dagSpec.edges, dagSpec.edges);
    assert.deepEqual(plan.dagSpec.layout, dagSpec.layout);
    assert.deepEqual(new Set(plan.rerunNodeIds), new Set(['retry', 'source']));
    assert.equal(plan.reusable.gate.status, 'completed');
    assert.equal(plan.reusable.gate.reusedFromRunId, 'original-run');
    assert.equal(plan.reusable.other.status, 'skipped');
    assert.equal(plan.reusable.other.reusedFromRunId, 'original-run');
    assert.equal(Object.hasOwn(plan.reusable, 'source'), false);
    assert.equal(Object.hasOwn(plan.reusable, 'retry'), false);
});
