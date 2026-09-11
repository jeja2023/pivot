const test = require('node:test');
const assert = require('node:assert/strict');
const {
    lintDagGraph,
    computeDagDiff,
    exportDagWorkflowSpec,
    importDagWorkflowSpec
} = require('../client/chat/dag-governance');

test('工作流治理与规范契约 (dag-governance)', async (t) => {
    await t.test('lintDagGraph 静态体检准确拦截循环依赖与悬空依赖', () => {
        // 环路 A -> B -> A
        const cyclicNodes = [
            { id: 'node_a', tool: 'llm.generate', dependsOn: ['node_b'] },
            { id: 'node_b', tool: 'report.format', dependsOn: ['node_a'] }
        ];
        const resCycle = lintDagGraph(cyclicNodes);
        assert.equal(resCycle.valid, false);
        assert.ok(resCycle.errors.some(e => e.type === 'circular_dependency'));

        // 悬空依赖 (node_x 不存在)
        const danglingNodes = [
            { id: 'node_1', tool: 'llm.generate', dependsOn: ['node_x'] }
        ];
        const resDangling = lintDagGraph(danglingNodes);
        assert.equal(resDangling.valid, false);
        assert.ok(resDangling.errors.some(e => e.type === 'dangling_dependency'));
    });

    await t.test('lintDagGraph 检查未配置工具与未声明连线的变量引用', () => {
        const nodes = [
            { id: 'node_1', tool: '', title: '未选工具节点', dependsOn: [] },
            { id: 'node_2', tool: 'llm.generate', input: { prompt: '使用 {{nodes.node_3.output.text}}' }, dependsOn: [] },
            { id: 'node_3', tool: 'report.format', dependsOn: [] }
        ];
        const res = lintDagGraph(nodes);
        assert.equal(res.valid, false);
        assert.ok(res.errors.some(e => e.type === 'missing_tool'));
        assert.ok(res.warnings.some(w => w.type === 'undeclared_dependency'));
    });

    await t.test('computeDagDiff 准确计算版本间节点增删改与连线调整', () => {
        const v1 = [
            { id: 'n1', tool: 'rag.query', title: '搜索知识库', dependsOn: [] },
            { id: 'n2', tool: 'llm.generate', title: '撰写草稿', dependsOn: ['n1'], input: { maxTokens: 100 } },
            { id: 'n3', tool: 'report.format', title: '格式化', dependsOn: ['n2'] }
        ];
        const v2 = [
            { id: 'n1', tool: 'rag.query', title: '搜索知识库', dependsOn: [] },
            { id: 'n2', tool: 'llm.generate', title: '撰写高质量草稿', dependsOn: ['n1'], input: { maxTokens: 500 } }, // modified
            { id: 'n4', tool: 'code.python', title: '数据校验', dependsOn: ['n2'] } // n3 deleted, n4 added
        ];

        const diff = computeDagDiff(v1, v2);
        assert.equal(diff.hasDifferences, true);
        assert.equal(diff.added.length, 1);
        assert.equal(diff.added[0].id, 'n4');
        assert.equal(diff.removed.length, 1);
        assert.equal(diff.removed[0].id, 'n3');
        assert.equal(diff.modified.length, 1);
        assert.equal(diff.modified[0].id, 'n2');
    });

    await t.test('exportDagWorkflowSpec 导出标准 schema 与坐标', () => {
        const spec = {
            cacheEnabled: true,
            nodes: [
                { id: 'node_a', title: '节点A', tool: 'llm.generate', input: { text: 'ok' }, dependsOn: [], _x: 100, _y: 200 }
            ]
        };
        const exported = exportDagWorkflowSpec(spec, { name: '自动化周报' });
        assert.equal(exported.schemaVersion, 'pivot.dag.v1');
        assert.equal(exported.metadata.name, '自动化周报');
        assert.equal(exported.spec.nodes.length, 1);
        assert.equal(exported.spec.nodes[0]._x, 100);
    });

    await t.test('importDagWorkflowSpec 导入校验与静态自检', () => {
        const badJson = '{ invalid }';
        assert.equal(importDagWorkflowSpec(badJson).ok, false);

        const validJson = JSON.stringify({
            spec: {
                cacheEnabled: true,
                nodes: [
                    { id: 'step_1', title: '提取数据', tool: 'rag.query', dependsOn: [] },
                    { id: 'step_2', title: '生成总结', tool: 'llm.generate', dependsOn: ['step_1'] }
                ]
            }
        });
        const imported = importDagWorkflowSpec(validJson);
        assert.equal(imported.ok, true);
        assert.equal(imported.spec.nodes.length, 2);
    });
});
