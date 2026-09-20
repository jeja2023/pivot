'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    ToolCatalogValidationError,
    compareCatalogReleases,
    normalizeCatalogTools
} = require('../server/services/tool-catalog-releases');
const { createToolPolicyEngine } = require('../server/services/tool-policy-engine');
const { resolveCatalogReference } = require('../server/services/tool-policy-engine');
const { publicConnectionAccount } = require('../server/services/connection-accounts');
const { newTaskId } = require('../server/services/tool-tasks');
const { rankToolsForPrompt, scoreSelection } = require('../server/services/tool-evaluations');
const { buildWorkflowToolReleaseBindings, mcpReferenceForNode } = require('../server/services/workflow-tool-releases');
const { getBuiltInToolDefinitions } = require('../server/services/agent-tools');

const echoTool = {
    name: 'echo.read',
    title: '读取回显',
    description: '读取并回显输入。',
    source: 'builtin',
    capabilities: ['knowledge.read'],
    input_schema: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1 } },
        required: ['text'],
        additionalProperties: false
    },
    output_schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false
    },
    idempotent: true,
    side_effect: false
};

test('工具目录规范化冻结输入、输出、风险与定义摘要', () => {
    const tools = normalizeCatalogTools([{
        name: 'orders.search',
        title: '订单查询',
        description: '按条件查询订单。',
        inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
        outputSchema: { type: 'object', properties: { rows: { type: 'array' } } },
        annotations: { readOnlyHint: true, idempotentHint: true },
        tags: ['订单', '查询']
    }], { serverId: 12 });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].fullName, 'mcp.12.orders.search');
    assert.equal(tools[0].idempotent, true);
    assert.equal(tools[0].riskLevel, 'high'); // MCP 默认网络风险，未声明网络边界不得降级
    assert.match(tools[0].definitionDigest, /^[a-f0-9]{64}$/);
});

test('工具目录拒绝无效工具名与破损 Schema', () => {
    assert.throws(() => normalizeCatalogTools([{
        name: 'bad tool', description: 'x', inputSchema: { type: 'object' }
    }], { serverId: 1 }), ToolCatalogValidationError);
    assert.throws(() => normalizeCatalogTools([{
        name: 'safe.tool', description: 'x', inputSchema: { type: 'array' }
    }], { serverId: 1 }), ToolCatalogValidationError);
});

test('目录差异将删除、输入收窄和输出变化视为破坏性变更', () => {
    const previous = [{ toolName: 'orders.search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, outputSchema: { type: 'object', properties: { rows: { type: 'array' } } }, definitionDigest: 'old' }, { toolName: 'orders.delete', inputSchema: {}, outputSchema: {}, definitionDigest: 'delete' }];
    const next = [{ toolName: 'orders.search', inputSchema: { type: 'object', properties: { q: { type: 'string', minLength: 3 } }, required: ['q'] }, outputSchema: { type: 'object', properties: { items: { type: 'array' } } }, definitionDigest: 'new' }];
    const comparison = compareCatalogReleases(previous, next);
    assert.equal(comparison.breaking, true);
    assert.equal(comparison.removed, 1);
    assert.equal(comparison.inputBreaking, 1);
    assert.equal(comparison.outputBreaking, 1);
});

test('统一 PEP 在执行前拒绝无效输入，并验证工具输出', async () => {
    const events = [];
    const engine = createToolPolicyEngine({
        formatToolList: async () => [echoTool],
        buildToolExecutionPlan: async ({ tool, input }) => ({
            tool: tool.name,
            input,
            policy: { decision: 'allow', reasons: [], reasonCodes: [] },
            approval: { required: false }, network: { preflight: 'not_applicable' }, retry: { retryable: true }
        }),
        recordToolInvocationEvent: async event => { events.push(event); return 'event-1'; }
    });
    await assert.rejects(
        () => engine.invoke({ actor: { id: 7 }, toolName: 'echo.read', input: {} }, async () => ({ text: 'ignored' })),
        error => error.code === 'TOOL_POLICY_DENIED'
    );
    const output = await engine.invoke({ actor: { id: 7 }, toolName: 'echo.read', input: { text: 'ok' }, source: 'manual_test' }, async evaluation => ({ text: evaluation.input.text }));
    assert.deepEqual(output, { text: 'ok' });
    await assert.rejects(
        () => engine.invoke({ actor: { id: 7 }, toolName: 'echo.read', input: { text: 'ok' } }, async () => ({ wrong: true })),
        error => error.code === 'TOOL_OUTPUT_INVALID'
    );
    assert.equal(events.some(event => event.policyDecision === 'denied'), true);
    assert.equal(events.some(event => event.status === 'success'), true);
});

test('连接账户公开投影永不返回秘密，工具任务 ID 不可预测且带前缀', () => {
    const account = publicConnectionAccount({ id: 1, encrypted_secret_ref: 'mcp_servers:1:api_key', scopes: '["orders.read"]', metadata: '{"provider":"erp"}' });
    assert.equal(account.encrypted_secret_ref, 'configured');
    assert.deepEqual(account.scopes, ['orders.read']);
    assert.deepEqual(account.metadata, { provider: 'erp' });
    const first = newTaskId();
    const second = newTaskId();
    assert.match(first, /^tooltask_[A-Za-z0-9_-]{32}$/);
    assert.notEqual(first, second);
});

test('渐进式发现按语义词排序，并为模型保留固定的 meta 工具', async () => {
    const ranked = rankToolsForPrompt('查询订单并统计', [
        { name: 'mcp.9.orders.search', title: '订单查询', description: '按条件查询订单和统计数量。', capabilities: ['data.sql.query'] },
        { name: 'viz.build_chart', title: '生成图表', description: '从表格生成图表。', capabilities: ['viz.render'] }
    ]);
    assert.equal(ranked[0].tool.name, 'mcp.9.orders.search');
    assert.deepEqual(scoreSelection(['mcp.9.orders.search'], ['mcp.9.orders.search']), { score: 1, top1: true, top3: true });
    const names = getBuiltInToolDefinitions({ id: 1, role: 'user' }).map(tool => tool.name);
    assert.equal(names.includes('tools.search'), true);
    assert.equal(names.includes('tools.describe'), true);
    assert.equal(names.includes('tools.execute'), true);
});

test('工作流发布冻结具体 MCP 工具的 release 与摘要', async () => {
    assert.deepEqual(mcpReferenceForNode({ tool: 'mcp.7.orders.search' }), { serverId: 7, toolName: 'orders.search', fullName: 'mcp.7.orders.search' });
    assert.deepEqual(mcpReferenceForNode({ tool: 'db.run_readonly_query', input: { connectionId: 8 } }), { serverId: 8, toolName: 'db.run_readonly_query', fullName: 'mcp.8.db.run_readonly_query' });
    const bindings = await buildWorkflowToolReleaseBindings({
        nodes: [{ id: 'search', tool: 'mcp.7.orders.search' }, { id: 'db', tool: 'db.run_readonly_query', input: { connectionId: 8 } }]
    }, {
        activeRelease: async serverId => ({ id: serverId + 100 }),
        releaseItems: async releaseId => [{ tool_name: releaseId === 107 ? 'orders.search' : 'db.run_readonly_query', definition_digest: `digest-${releaseId}` }]
    });
    assert.deepEqual(bindings.map(item => [item.nodeId, item.releaseId, item.definitionDigest]), [['search', 107, 'digest-107'], ['db', 108, 'digest-108']]);
});

test('显式 toolRef release 必须属于对应工具服务，不能静默回退到最新版本', async () => {
    await assert.rejects(
        () => resolveCatalogReference('mcp.7.orders.search', {}, { releaseId: 33 }, {
            getCatalogRelease: async () => null,
            activeRelease: async () => ({ id: 99 })
        }),
        error => error.code === 'TOOL_RELEASE_NOT_FOUND'
    );
    const resolved = await resolveCatalogReference('mcp.7.orders.search', {}, {}, {
        activeRelease: async () => ({ id: 99, status: 'active' }),
        releaseItems: async () => [{ tool_name: 'orders.search', definition_digest: 'abc' }]
    });
    assert.equal(resolved.release.id, 99);
    assert.equal(resolved.item.definition_digest, 'abc');
});
