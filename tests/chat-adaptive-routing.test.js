const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildRouteMetadata,
    buildRouteSseEvent,
    createSemanticRouter,
    isConversationOnlyPrompt,
    normalizeRouteOverrides
} = require('../server/services/semantic-router');
const { getChatAutoRouteConfig } = require('../server/services/chat-route-config');
const { buildChatPromptCache, isPromptCacheUnsupported } = require('../server/services/model-stream-service');
const { flushPendingChatRouteMetrics, recordChatRouteMetric } = require('../server/services/chat-route-observability');

function routerForTests({ collections = [], vectors = null, config = {} } = {}) {
    const metrics = [];
    return {
        metrics,
        router: createSemanticRouter({
            getChatAutoRouteConfig: () => ({
                enabled: true,
                autoRagEnabled: true,
                autoToolDiscoveryEnabled: true,
                shadowMode: false,
                maxToolCandidates: 2,
                maxCollections: 2,
                ragThreshold: 0.34,
                ragGrayThreshold: 0.16,
                toolThreshold: 0.2,
                embeddingTimeoutMs: 100,
                ...config
            }),
            getEmbeddingConfig: () => ({ http: { url: vectors ? 'http://embedding.local' : '', model: 'test' } }),
            generateEmbedding: async () => vectors || [],
            knowledgeCatalogIndex: {
                getVisibleEntries: async () => collections,
                scheduleRefresh() {}
            },
            mcpToolCatalogIndex: {
                getEntries: values => values.map(tool => ({ tool, semanticSignature: tool.description || tool.name, vector: tool.vector || [] })),
                scheduleRefresh() {}
            },
            recordChatRouteMetric: metric => metrics.push(metric)
        })
    };
}

test('自适应路由清理显式覆盖，禁止把非 MCP 名称传入工具覆盖', () => {
    assert.deepEqual(normalizeRouteOverrides({
        collections: ['12', 'x', -1, 12],
        tools: ['mcp.3.db.query', 'db.query', 'mcp.bad.query'],
        excludedTools: ['mcp.4.viz.chart', 'mcp.4.viz.chart']
    }), {
        collections: [12],
        tools: ['mcp.3.db.query'],
        excludedTools: ['mcp.4.viz.chart'],
        excludeRag: false,
        excludeTools: false
    });
});

test('纯闲聊不触发知识库或工具发现', async () => {
    const { router } = routerForTests({
        collections: [{ collectionId: 12, name: '财务制度', description: '报销制度', domainTags: [], vector: [] }]
    });
    const plan = await router.resolveRoutePlan({
        prompt: '你好！',
        user: { id: 7 },
        state: { ragEnabled: true, mcpEnabled: false, autoRouteEnabled: true }
    });
    assert.equal(isConversationOnlyPrompt('你好！'), true);
    assert.equal(plan.rag.action, 'skip');
    assert.equal(plan.rag.reasonCode, 'conversation_only');
    assert.equal(plan.tools.action, 'skip');
});

test('知识库自动路由只使用可访问目录并把整数 Collection ID 放入范围', async () => {
    const { router } = routerForTests({
        collections: [
            { collectionId: 12, name: '财务报销制度', description: '差旅、发票与费用报销审批流程', domainTags: ['财务', '报销'], vector: [] },
            { collectionId: 88, name: '研发规范', description: '代码评审与发布流程', domainTags: ['研发'], vector: [] }
        ]
    });
    const plan = await router.resolveRoutePlan({
        prompt: '差旅发票怎样报销，需要谁审批？',
        user: { id: 7 },
        state: { ragEnabled: true, mcpEnabled: false, autoRouteEnabled: true }
    });
    assert.equal(plan.rag.action, 'retrieve');
    assert.deepEqual(plan.execution.rag.scope.collectionIds, [12]);
    assert.equal(Number.isInteger(plan.rag.collections[0].id), true);
    assert.equal(plan.execution.rag.queryVector, null);
});

test('显式知识库范围优先于自动路由且即使向量不可用仍可检索', async () => {
    const { router } = routerForTests({ collections: [] });
    const plan = await router.resolveRoutePlan({
        prompt: '请依据当前资料回答',
        user: { id: 7 },
        state: {
            ragEnabled: true,
            mcpEnabled: false,
            autoRouteEnabled: true,
            ragScope: { collectionId: 19 },
            routeOverrides: { collections: [20] }
        }
    });
    assert.equal(plan.rag.action, 'retrieve');
    assert.deepEqual(plan.execution.rag.scope.collectionIds, [20]);
    assert.equal(plan.rag.reasonCode, 'explicit_rag_scope');
});

test('工具路由仅缩小已传入的治理后工具集，并保留强数据规则', async () => {
    const permitted = {
        fullName: 'mcp.3.db.run_readonly_query',
        name: 'db.run_readonly_query',
        serverName: '业务数据库',
        serverType: 'database',
        description: '执行只读 SQL 数据查询'
    };
    const { router } = routerForTests({ tools: [permitted] });
    const plan = await router.resolveRoutePlan({
        prompt: '查询 orders 表的数量并按状态统计',
        user: { id: 7 },
        availableMcpTools: [permitted],
        state: { ragEnabled: false, mcpEnabled: true, autoRouteEnabled: true }
    });
    assert.equal(plan.tools.action, 'propose');
    assert.deepEqual(plan.execution.tools.candidates, [permitted]);
    assert.equal(plan.tools.candidates[0].fullName, permitted.fullName);
});

test('未确认 MCP 时只表达待授权状态，不产生工具执行候选', async () => {
    const tool = { fullName: 'mcp.3.db.run_readonly_query', name: 'db.run_readonly_query', description: '查询数据库' };
    const { router } = routerForTests();
    const plan = await router.resolveRoutePlan({
        prompt: '查询 orders 表的数量',
        user: { id: 7 },
        availableMcpTools: [tool],
        state: { ragEnabled: false, mcpEnabled: false, autoRouteEnabled: true }
    });
    assert.equal(plan.tools.action, 'candidate_only');
    assert.equal(plan.execution.tools.shouldPlan, false);
    assert.deepEqual(plan.execution.tools.candidates, []);
    assert.equal(plan.tools.candidates[0].fullName, tool.fullName);
});

test('影子模式保持原始 RAG 与 MCP 执行集合，并透出安全摘要', async () => {
    const tool = { fullName: 'mcp.3.db.run_readonly_query', name: 'db.run_readonly_query', description: '查询数据库' };
    const { router } = routerForTests({ config: { shadowMode: true } });
    const plan = await router.resolveRoutePlan({
        prompt: '查询数据库 orders 表',
        user: { id: 7 },
        availableMcpTools: [tool],
        state: { ragEnabled: true, mcpEnabled: true, autoRouteEnabled: true, ragScope: { collectionId: 10 } },
        env: {}
    });
    assert.equal(plan.shadow, true);
    assert.deepEqual(plan.execution.rag.scope.collectionIds, [10]);
    assert.deepEqual(plan.execution.tools.candidates, [tool]);
    const metadata = buildRouteMetadata(plan);
    assert.equal(JSON.stringify(metadata).includes('queryVector'), false);
    assert.equal(buildRouteSseEvent(plan).type, 'route');
});

test('类型化路由配置收敛布尔、数字与边界值', () => {
    const config = getChatAutoRouteConfig({
        PIVOT_CHAT_AUTO_ROUTE_ENABLED: 'off',
        PIVOT_CHAT_ROUTE_MAX_TOOL_CANDIDATES: '999',
        PIVOT_CHAT_ROUTE_RAG_THRESHOLD: '1.8',
        PIVOT_CHAT_ROUTE_RAG_GRAY_THRESHOLD: '-1'
    });
    assert.equal(config.enabled, false);
    assert.equal(config.maxToolCandidates, 12);
    assert.equal(config.ragThreshold, 1);
    assert.equal(config.ragGrayThreshold, 0);
});

test('Responses Prompt Cache 使用会话隔离 key，并仅对明确缓存参数错误降级', () => {
    const cache = buildChatPromptCache({ id: 42 }, {
        sessionId: 'session-abc',
        userId: 8,
        env: { PIVOT_CHAT_PROMPT_CACHE_ENABLED: 'true', PIVOT_CHAT_PROMPT_CACHE_TTL: '30m' }
    });
    assert.deepEqual(cache, {
        prompt_cache_key: 'pivot:chat:42:user:8:session:session-abc',
        prompt_cache_options: { mode: 'implicit', ttl: '30m' }
    });
    assert.equal(isPromptCacheUnsupported({ response: { status: 400, data: { error: { message: 'unknown prompt_cache_key' } } } }), true);
    assert.equal(isPromptCacheUnsupported({ response: { status: 400, data: { error: { message: 'invalid model' } } } }), false);
});

test('聊天路由指标按桶聚合后批量持久化，且不携带提问原文', async () => {
    recordChatRouteMetric({
        routeMode: 'auto', ragAction: 'retrieve', toolAction: 'propose',
        routeDurationMs: 10, embeddingDurationMs: 6, ragCandidates: 2, toolCandidates: 3,
        now: Date.parse('2026-09-18T12:00:30Z')
    });
    recordChatRouteMetric({
        routeMode: 'auto', ragAction: 'retrieve', toolAction: 'propose',
        routeDurationMs: 20, embeddingDurationMs: 8, ragCandidates: 1, toolCandidates: 1,
        now: Date.parse('2026-09-18T12:00:45Z')
    });
    const calls = [];
    const flushed = await flushPendingChatRouteMetrics({ execute: async (sql, params) => calls.push({ sql, params }) });
    assert.equal(flushed, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /ON CONFLICT/);
    assert.equal(calls[0].params[4], 2);
    assert.equal(calls[0].params[6], 30);
    assert.equal(calls[0].params[8], 3);
    assert.equal(calls[0].params.includes('不应保存的用户提问'), false);
});
