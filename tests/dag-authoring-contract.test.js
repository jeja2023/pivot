const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getUpstreamNodes,
    getAvailableVariableOptions,
    alignNodes
} = require('../client/chat/dag-core');
const { resolveDagNodeInput } = require('../server/services/agent-dag-utils');

test('DAG 拓扑上游节点推导 (getUpstreamNodes)', async (t) => {
    await t.test('线性依赖链能够完整推导所有多级前序节点', () => {
        const nodes = [
            { id: 'node_a', title: '起点 A', dependsOn: [] },
            { id: 'node_b', title: '处理 B', dependsOn: ['node_a'] },
            { id: 'node_c', title: '终点 C', dependsOn: ['node_b'] },
            { id: 'node_isolated', title: '孤立节点', dependsOn: [] }
        ];
        const upstreamOfC = getUpstreamNodes(nodes, 'node_c');
        assert.equal(upstreamOfC.length, 2);
        assert.deepEqual(upstreamOfC.map(n => n.id), ['node_a', 'node_b']);

        const upstreamOfB = getUpstreamNodes(nodes, 'node_b');
        assert.equal(upstreamOfB.length, 1);
        assert.equal(upstreamOfB[0].id, 'node_a');

        const upstreamOfA = getUpstreamNodes(nodes, 'node_a');
        assert.equal(upstreamOfA.length, 0);
    });

    await t.test('多分支汇聚能够准确去重并收集前序节点', () => {
        const nodes = [
            { id: 'start', title: '输入', dependsOn: [] },
            { id: 'branch_1', title: '分支 1', dependsOn: ['start'] },
            { id: 'branch_2', title: '分支 2', dependsOn: ['start'] },
            { id: 'merge', title: '汇总', dependsOn: ['branch_1', 'branch_2'] }
        ];
        const upstreamOfMerge = getUpstreamNodes(nodes, 'merge');
        assert.equal(upstreamOfMerge.length, 3);
        const ids = upstreamOfMerge.map(n => n.id);
        assert.ok(ids.includes('start'));
        assert.ok(ids.includes('branch_1'));
        assert.ok(ids.includes('branch_2'));
    });

    await t.test('遇到空或异常不存在的 targetNodeId 安全返回空数组', () => {
        const nodes = [{ id: 'n1', dependsOn: [] }];
        assert.deepEqual(getUpstreamNodes(nodes, ''), []);
        assert.deepEqual(getUpstreamNodes(nodes, 'non_existent'), []);
    });
});

test('可用变量与 Output Schema 字段萃取 (getAvailableVariableOptions)', async (t) => {
    await t.test('能提取全局变量与上游节点输出字段', () => {
        const nodes = [
            {
                id: 'db_node',
                title: '用户表查询',
                tool: 'db.query',
                dependsOn: [],
                outputSchema: {
                    type: 'object',
                    properties: {
                        rows: { type: 'array', description: '数据行列表' },
                        totalCount: { type: 'number', title: '总记录数' }
                    }
                }
            },
            {
                id: 'llm_node',
                title: '报告撰写',
                tool: 'agent.llm',
                dependsOn: ['db_node']
            }
        ];

        const options = getAvailableVariableOptions(nodes, 'llm_node', []);
        assert.ok(options.length >= 2, '应该包含全局变量和上游节点两组');

        const globalGroup = options.find(g => g.group === '全局变量');
        assert.ok(globalGroup);
        assert.ok(globalGroup.items.some(it => it.expression === '{{goal}}'));
        assert.ok(globalGroup.items.some(it => it.expression === '{{inputs}}'));

        const upstreamGroup = options.find(g => g.nodeId === 'db_node');
        assert.ok(upstreamGroup);
        assert.ok(upstreamGroup.items.some(it => it.expression === '{{nodes.db_node.output}}'));
        assert.ok(upstreamGroup.items.some(it => it.expression === '{{nodes.db_node.output.rows}}'));
        assert.ok(upstreamGroup.items.some(it => it.expression === '{{nodes.db_node.output.totalCount}}'));
    });

    await t.test('无显式 Schema 时按工具默认推断常见输出字段', () => {
        const nodes = [
            { id: 'ai_1', title: '智能分析', tool: 'agent.llm', dependsOn: [] },
            { id: 'ai_2', title: '下层', tool: 'agent.llm', dependsOn: ['ai_1'] }
        ];
        const options = getAvailableVariableOptions(nodes, 'ai_2', []);
        const group = options.find(g => g.nodeId === 'ai_1');
        assert.ok(group);
        assert.ok(group.items.some(it => it.expression === '{{nodes.ai_1.output.text}}'));
    });
});

test('多节点批量对齐算法 (alignNodes)', async (t) => {
    await t.test('水平居中对齐 (horizontal_center)', () => {
        const nodes = [
            { id: 'n1', _x: 100, _y: 100 },
            { id: 'n2', _x: 300, _y: 200 }
        ];
        const res = alignNodes(nodes, ['n1', 'n2'], 'horizontal_center');
        assert.equal(res.changed, true);
        assert.equal(res.modifiedCount, 2);
        assert.equal(nodes[0]._x, 200);
        assert.equal(nodes[1]._x, 200);
    });

    await t.test('左边缘与顶端对齐 (left / top)', () => {
        const nodes = [
            { id: 'n1', _x: 150, _y: 80 },
            { id: 'n2', _x: 250, _y: 180 }
        ];
        alignNodes(nodes, ['n1', 'n2'], 'left');
        assert.equal(nodes[0]._x, 150);
        assert.equal(nodes[1]._x, 150);

        alignNodes(nodes, ['n1', 'n2'], 'top');
        assert.equal(nodes[0]._y, 80);
        assert.equal(nodes[1]._y, 80);
    });

    await t.test('水平等间距分布 (distribute_h)', () => {
        const nodes = [
            { id: 'n1', _x: 100, _y: 50 },
            { id: 'n2', _x: 500, _y: 50 },
            { id: 'n3', _x: 120, _y: 50 }
        ];
        const res = alignNodes(nodes, ['n1', 'n2', 'n3'], 'distribute_h');
        assert.equal(res.changed, true);
        assert.equal(nodes.find(n => n.id === 'n1')._x, 100);
        assert.equal(nodes.find(n => n.id === 'n3')._x, 300);
        assert.equal(nodes.find(n => n.id === 'n2')._x, 500);
    });

    await t.test('少于两个节点不产生修改', () => {
        const nodes = [{ id: 'n1', _x: 100, _y: 100 }];
        const res = alignNodes(nodes, ['n1'], 'left');
        assert.equal(res.changed, false);
    });
});

test('单节点测试上下文与模板变量求值契约 (resolveDagNodeInput)', async () => {
    const rawInput = {
        prompt: '分析上游数据：{{nodes.step_1.output.summary}}，任务目标：{{goal}}',
        model: 'deepseek-chat',
        userId: '{{inputs.currentUserId}}'
    };

    const context = {
        goal: '生成本月经营研报',
        inputs: { currentUserId: 'user_998' },
        states: new Map([
            ['step_1', {
                status: 'completed',
                output: { summary: '本月营业额增长 15%' }
            }]
        ]),
        nodeMap: new Map([
            ['step_1', { id: 'step_1', title: '数据总结' }]
        ])
    };

    const resolved = resolveDagNodeInput({ tool: 'agent.llm', input: rawInput }, context);
    assert.equal(resolved.prompt, '分析上游数据：本月营业额增长 15%，任务目标：生成本月经营研报');
    assert.equal(resolved.model, 'deepseek-chat');
    assert.equal(resolved.userId, 'user_998');
});
