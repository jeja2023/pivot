const test = require('node:test');
const assert = require('node:assert/strict');
const {
    computeDagNodeCacheKey,
    getCachedNodeOutput,
    setCachedNodeOutput,
    clearDagNodeCache,
    isCacheableDagTool,
    normalizeCacheScope,
    stableStringify
} = require('../server/services/agent-dag-cache');

test('DAG 节点级智能缓存契约', async (t) => {
    t.beforeEach(() => {
        clearDagNodeCache();
    });

    await t.test('stableStringify 稳态排序序列化避免对象键顺序不同产生不同结果', () => {
        const objA = { z: 1, a: 2, m: { y: 'hello', b: 'world' } };
        const objB = { a: 2, m: { b: 'world', y: 'hello' }, z: 1 };
        assert.equal(stableStringify(objA), stableStringify(objB));
    });

    await t.test('computeDagNodeCacheKey 基于入参、依赖及授权作用域生成稳定哈希', () => {
        const key1 = computeDagNodeCacheKey({
            tool: 'workflow.template',
            input: { prompt: '总结公文', maxTokens: 100 },
            dependsOnOutputs: { node_1: { text: '原始内容' } },
            workflowId: 'workflow-1',
            nodeKey: 'summary',
            scope: { userId: 7, tenantId: 3, workflowVersionId: 9, toolVersion: '1.0.0', bindingVersionId: 12 }
        });
        const key2 = computeDagNodeCacheKey({
            tool: 'workflow.template',
            input: { maxTokens: 100, prompt: '总结公文' },
            dependsOnOutputs: { node_1: { text: '原始内容' } },
            workflowId: 'workflow-1',
            nodeKey: 'summary',
            scope: { tenantId: 3, userId: 7, toolVersion: '1.0.0', workflowVersionId: 9, bindingVersionId: 12 }
        });
        const keyDiff = computeDagNodeCacheKey({
            tool: 'workflow.template',
            input: { maxTokens: 100, prompt: '修改公文' },
            dependsOnOutputs: { node_1: { text: '原始内容' } },
            workflowId: 'workflow-1',
            nodeKey: 'summary',
            scope: { userId: 7, tenantId: 3, workflowVersionId: 9, toolVersion: '1.0.0', bindingVersionId: 12 }
        });
        const differentUser = computeDagNodeCacheKey({
            tool: 'workflow.template',
            input: { maxTokens: 100, prompt: '总结公文' },
            dependsOnOutputs: { node_1: { text: '原始内容' } },
            workflowId: 'workflow-1',
            nodeKey: 'summary',
            scope: { userId: 8, tenantId: 3, workflowVersionId: 9, toolVersion: '1.0.0', bindingVersionId: 12 }
        });

        assert.ok(typeof key1 === 'string' && key1.length === 64);
        assert.equal(key1, key2);
        assert.notEqual(key1, keyDiff);
        assert.notEqual(key1, differentUser);
        assert.deepEqual(normalizeCacheScope({ user_id: 7, tenant_id: 3, workflow_id: 'workflow-1' }), {
            userId: '7', tenantId: '3', workflowId: 'workflow-1', workflowVersionId: '', nodeId: '',
            toolVersion: '', modelId: '', modelName: '', bindingVersionId: '', bindingUpdatedAt: ''
        });
    });

    await t.test('缓存存取与访问统计命中', () => {
        const key = 'test_key_123';
        const payload = { summary: '提取成功', count: 42 };

        const initial = getCachedNodeOutput(key);
        assert.equal(initial.hit, false);

        setCachedNodeOutput(key, payload, 5000);
        const hit1 = getCachedNodeOutput(key);
        assert.equal(hit1.hit, true);
        assert.deepEqual(hit1.output, payload);
        assert.equal(hit1.hits, 1);

        const hit2 = getCachedNodeOutput(key);
        assert.equal(hit2.hit, true);
        assert.equal(hit2.hits, 2);
    });

    await t.test('缓存过期与清除', async () => {
        const key = 'test_expiring_key';
        setCachedNodeOutput(key, { value: 999 }, 20); // 20ms TTL

        // 立即读取命中
        assert.equal(getCachedNodeOutput(key).hit, true);

        // 等待 30ms 过期
        await new Promise(r => setTimeout(r, 30));
        assert.equal(getCachedNodeOutput(key).hit, false);

        // 手动清除
        setCachedNodeOutput('key_a', 'val_a');
        clearDagNodeCache();
        assert.equal(getCachedNodeOutput('key_a').hit, false);
    });

    await t.test('isCacheableDagTool 只接受契约显式允许的无副作用工具', () => {
        assert.equal(isCacheableDagTool({ name: 'workflow.template', cacheable: true, side_effect: false, approval_required: false }), true);
        assert.equal(isCacheableDagTool({ name: 'mcp.1.db.insert', cacheable: true, side_effect: true, approval_required: false }), false);
        assert.equal(isCacheableDagTool({ name: 'agent.http', cacheable: true, side_effect: false, approval_required: true }), false);
        assert.equal(isCacheableDagTool({ name: 'agent.code', cacheable: true, side_effect: false, approval_required: false, requiresSandbox: true }), false);
        assert.equal(isCacheableDagTool({ name: 'unknown.tool', side_effect: false, approval_required: false }), false);
        assert.equal(isCacheableDagTool('rag.search'), false);
    });

    await t.test('computeTimelineData 准确计算执行耗时瀑布与慢节点/缓存统计', () => {
        const { computeTimelineData } = require('../client/chat/dag-timeline-waterfall');
        const nodes = [
            { id: 'node_1', title: '向量检索', tool: 'rag.query' },
            { id: 'node_2', title: '大模型推理', tool: 'llm.generate' },
            { id: 'node_3', title: '报表渲染', tool: 'report.format' }
        ];
        const runStates = new Map([
            ['node_1', { status: 'completed', durationMs: 1200 }],
            ['node_2', { status: 'completed', durationMs: 4500 }],
            ['node_3', { status: 'completed', cached: true, durationMs: 1 }]
        ]);

        const data = computeTimelineData(nodes, runStates);
        assert.equal(data.totalNodes, 3);
        assert.equal(data.completedCount, 3);
        assert.equal(data.cachedCount, 1);
        assert.equal(data.slowCount, 1); // node_2 > 3000ms
        assert.equal(data.items[1].isSlow, true);
        assert.equal(data.items[2].isCached, true);
        assert.ok(data.totalDurationMs >= 5700);
    });
});
