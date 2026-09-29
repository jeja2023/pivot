const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildRouteMetadata,
    buildRouteSseEvent,
    createSemanticRouter,
    isConversationOnlyPrompt,
    requiresKnowledgeRetrieval,
    normalizeRouteOverrides
} = require('../server/services/semantic-router');
const { getChatAutoRouteConfig } = require('../server/services/chat-route-config');
const { requiresMcpConsentForRoute } = require('../server/services/chat-context-assembler');
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

test('@ 工具选择固定受治理候选，主动决策不能改判为跳过', async () => {
    const tool = {
        fullName: 'mcp.3.db.run_readonly_query', name: 'db.run_readonly_query',
        serverName: '业务数据库', serverType: 'database', description: '执行只读 SQL 数据查询'
    };
    const decisionCandidates = [];
    const router = createSemanticRouter({
        getChatAutoRouteConfig: () => ({ enabled: true, autoRagEnabled: true, autoToolDiscoveryEnabled: true, shadowMode: false, maxToolCandidates: 2, maxCollections: 2, ragThreshold: 0.34, ragGrayThreshold: 0.16, toolThreshold: 0.2, embeddingTimeoutMs: 100 }),
        getEmbeddingConfig: () => ({ http: { url: '' } }),
        knowledgeCatalogIndex: { getVisibleEntries: async () => [], scheduleRefresh() {} },
        mcpToolCatalogIndex: { getEntries: values => values.map(value => ({ tool: value, semanticSignature: value.description, vector: [] })), scheduleRefresh() {} },
        recordChatRouteMetric() {},
        resolveBusinessDecision: async input => {
            if (input.scenario === 'chat.tools') {
                decisionCandidates.push(input.candidates.map(candidate => [candidate.id, candidate.allowed]));
                // 模拟不可信或过时的策略输出；用户的 @ 显式选择必须仍优先。
                return { decisionId: 'tools-decision', context: { scenario: 'chat.tools', candidates: input.candidates }, selectedActionId: 'skip', policy: { applied: true, confidence: 0.99, reasonCode: 'stale_model' } };
            }
            return { decisionId: input.scenario, context: { scenario: input.scenario, candidates: input.candidates }, selectedActionId: input.fallbackActionId, policy: { applied: false } };
        }
    });
    const plan = await router.resolveRoutePlan({
        prompt: '说明这张表的查询方式', user: { id: 7 }, availableMcpTools: [tool],
        state: {
            ragEnabled: false, mcpEnabled: true, autoRouteEnabled: true,
            routeOverrides: { tools: [tool.fullName] }
        }
    });
    assert.deepEqual(decisionCandidates, [[['propose', true], ['candidate_only', false], ['skip', false]]]);
    assert.equal(plan.tools.action, 'propose');
    assert.deepEqual(plan.execution.tools.candidates, [tool]);
});

test('知识库目录加载失败会回退原有全范围检索，不会把已启用 RAG 误路由为跳过', async () => {
    const router = createSemanticRouter({
        getChatAutoRouteConfig: () => ({ enabled: true, autoRagEnabled: true, autoToolDiscoveryEnabled: false, shadowMode: false, maxToolCandidates: 2, maxCollections: 2, ragThreshold: 0.58, ragGrayThreshold: 0.38, toolThreshold: 0.34, embeddingTimeoutMs: 100 }),
        getEmbeddingConfig: () => ({ http: { url: '' } }),
        knowledgeCatalogIndex: { getVisibleEntries: async () => { throw new Error('catalog_unavailable'); }, scheduleRefresh() {} },
        mcpToolCatalogIndex: { getEntries: () => [], scheduleRefresh() {} },
        recordChatRouteMetric() {},
        resolveBusinessDecision: async ({ scenario, fallbackActionId }) => ({ decisionId: scenario, context: { scenario }, selectedActionId: fallbackActionId, policy: { applied: false } })
    });
    const plan = await router.resolveRoutePlan({
        prompt: '请依据公司报销制度回答', user: { id: 7 },
        state: { ragEnabled: true, mcpEnabled: false, autoRouteEnabled: true }
    });
    assert.equal(plan.rag.action, 'retrieve');
    assert.equal(plan.rag.reasonCode, 'rag_router_fallback_legacy');
    assert.equal(plan.execution.rag.shouldRetrieve, true);
    assert.equal(plan.rag.routeError, true);
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
    assert.equal(requiresMcpConsentForRoute(plan, false), true);
    assert.equal(requiresMcpConsentForRoute(plan, true), false);
    assert.equal(requiresMcpConsentForRoute({ ...plan, shadow: true }, false), false);
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
    const circularObj = {};
    circularObj.self = circularObj;
    assert.equal(isPromptCacheUnsupported({ response: { status: 500, data: circularObj } }), false);
    assert.equal(isPromptCacheUnsupported({ response: { status: 400, data: circularObj } }), false);
    assert.equal(isPromptCacheUnsupported({ response: { status: 400, data: circularObj } }, 'unsupported cache parameter'), true);
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

test('影子期保留所有受许可候选以比较替代动作，但不改变执行路径', async () => {
    const calls = [];
    const router = createSemanticRouter({
        getChatAutoRouteConfig: () => ({ enabled: true, autoRagEnabled: true, autoToolDiscoveryEnabled: true, shadowMode: true, maxToolCandidates: 2, maxCollections: 2, ragThreshold: 0.34, ragGrayThreshold: 0.16, toolThreshold: 0.2, embeddingTimeoutMs: 100 }),
        getEmbeddingConfig: () => ({ http: { url: '' } }),
        generateEmbedding: async () => [],
        getPrimaryTenantId: async () => 4,
        knowledgeCatalogIndex: { getVisibleEntries: async () => [], scheduleRefresh() {} },
        mcpToolCatalogIndex: { getEntries: values => values.map(tool => ({ tool, semanticSignature: tool.description, vector: [] })), scheduleRefresh() {} },
        recordChatRouteMetric() {},
        resolveBusinessDecision: async input => {
            calls.push({ scenario: input.scenario, candidates: input.candidates.map(candidate => [candidate.id, candidate.allowed]) });
            return { decisionId: 'shadow-' + input.scenario, context: { scenario: input.scenario }, selectedActionId: input.fallbackActionId, policy: { mode: 'shadow', suggestedActionId: 'skip', confidence: 0.9, threshold: 0.58, reasonCode: 'shadow_mode', applied: false } };
        }
    });
    const tool = { fullName: 'mcp.3.db.query', name: 'db.query', description: '查询数据库' };
    const plan = await router.resolveRoutePlan({
        prompt: '查询订单数量',
        taskState: { hash: 'shadow-candidates', currentQuestion: '查询订单数量', toolIntent: { requestedCapabilities: ['data.query'] } },
        user: { id: 7 }, availableMcpTools: [tool],
        state: { ragEnabled: true, mcpEnabled: true, autoRouteEnabled: true }
    });
    assert.equal(plan.execution.rag.shouldRetrieve, true);
    assert.equal(plan.execution.tools.shouldPlan, true);
    // 非知识型的数据请求在影子模式也不应额外触发知识库决策；执行层仍保留
    // 旧范围，以便影子模式不改变历史行为。
    assert.equal(calls.some(call => call.scenario === 'chat.rag'), false);
    assert.deepEqual(calls.find(call => call.scenario === 'chat.tools').candidates, [['propose', true], ['candidate_only', false], ['skip', true]]);
    assert.deepEqual(calls.find(call => call.scenario === 'chat.next_step').candidates, [['direct_answer', true], ['clarify', true]]);
});

test('常规公文写作、总结提纲、Markdown 表格对比与代码编写不误判为工具调用候选', async () => {
    const dbTool = {
        fullName: 'mcp.0.db.list_tables',
        name: 'db.list_tables',
        serverName: '数据库服务',
        serverType: 'database',
        description: '列出当前数据库中可查询的数据表和视图'
    };
    const reportTool = {
        fullName: 'mcp.0.reports.list_files',
        name: 'reports.list_files',
        serverName: '报表服务',
        serverType: 'reports',
        description: '扫描本地报表目录下的文件列表'
    };
    const { router } = routerForTests({ tools: [dbTool, reportTool] });

    const nonToolPrompts = [
        '帮我写一篇述职报告',
        '写一份本周工作周报',
        '请列出两者的优缺点，用表格对比',
        '生成一份市场调研报告框架',
        '帮我看看这个表格怎么填写',
        '请列出一个对比表格',
        '统计一下有哪些问题，请列出建议',
        '查询并列出几个代表性的例子',
        '请写一个查询用户表的SQL'
    ];

    for (const prompt of nonToolPrompts) {
        const plan = await router.resolveRoutePlan({
            prompt,
            user: { id: 7 },
            availableMcpTools: [dbTool, reportTool],
            state: { ragEnabled: false, mcpEnabled: false, autoRouteEnabled: true }
        });
        assert.equal(plan.tools.action, 'skip', `Prompt "${prompt}" should not trigger tool candidate (was ${plan.tools.action})`);
        assert.equal(requiresMcpConsentForRoute(plan, false), false);
    }
});

test('仅解释数据库或工具库概念不会触发 MCP 授权；明确查询仍会进入受控授权路径', async () => {
    const dbTool = {
        fullName: 'mcp.0.db.describe_table', name: 'db.describe_table', serverName: '数据库服务',
        serverType: 'database', description: '查看数据库表结构和字段说明'
    };
    const { router } = routerForTests({ tools: [dbTool] });
    const conceptual = await router.resolveRoutePlan({
        prompt: '请解释数据库表是什么，以及工具库有什么作用', user: { id: 7 }, availableMcpTools: [dbTool],
        state: { ragEnabled: false, mcpEnabled: false, autoRouteEnabled: true }
    });
    assert.equal(conceptual.tools.action, 'skip');
    assert.equal(requiresMcpConsentForRoute(conceptual, false), false);
    const operational = await router.resolveRoutePlan({
        prompt: '请查询 orders 表的字段结构', user: { id: 7 }, availableMcpTools: [dbTool],
        state: { ragEnabled: false, mcpEnabled: false, autoRouteEnabled: true }
    });
    assert.equal(operational.tools.action, 'candidate_only');
    assert.equal(requiresMcpConsentForRoute(operational, false), true);
});

test('普通回答不加载知识库或工具目录，只有受控资料和真实数据请求才按需唤醒路由', async () => {
    const calls = { embedding: 0, collections: 0, tools: 0, decisions: [] };
    const dbTool = {
        fullName: 'mcp.0.db.run_readonly_query', name: 'db.run_readonly_query',
        serverName: '业务数据库', serverType: 'database', description: '查询订单、客户和销售数据'
    };
    const router = createSemanticRouter({
        getChatAutoRouteConfig: () => ({ enabled: true, autoRagEnabled: true, autoToolDiscoveryEnabled: true, shadowMode: false, maxToolCandidates: 2, maxCollections: 2, ragThreshold: 0.34, ragGrayThreshold: 0.16, toolThreshold: 0.2, embeddingTimeoutMs: 100 }),
        getEmbeddingConfig: () => ({ http: { url: 'http://embedding.local' } }),
        generateEmbedding: async () => { calls.embedding += 1; return []; },
        knowledgeCatalogIndex: {
            getVisibleEntries: async () => { calls.collections += 1; return [{ collectionId: 12, name: '差旅报销制度', description: '发票与审批流程', domainTags: [], vector: [] }]; },
            scheduleRefresh() {}
        },
        mcpToolCatalogIndex: {
            getEntries: values => { calls.tools += 1; return values.map(tool => ({ tool, semanticSignature: tool.description || tool.name, vector: [] })); },
            scheduleRefresh() {}
        },
        recordChatRouteMetric() {},
        resolveBusinessDecision: async input => {
            calls.decisions.push(input.scenario);
            return { decisionId: input.scenario, context: { scenario: input.scenario }, selectedActionId: input.fallbackActionId, policy: { applied: false } };
        }
    });

    const ordinary = await router.resolveRoutePlan({
        prompt: '帮我写一份季度经营分析报告', user: { id: 7 }, availableMcpTools: [dbTool],
        state: { ragEnabled: true, mcpEnabled: false, autoRouteEnabled: true }
    });
    assert.equal(ordinary.rag.reasonCode, 'rag_not_requested');
    assert.equal(ordinary.tools.reasonCode, 'tool_not_requested');
    assert.equal(requiresMcpConsentForRoute(ordinary, false), false);
    assert.deepEqual(calls, { embedding: 0, collections: 0, tools: 0, decisions: ['chat.next_step'] });

    const knowledge = await router.resolveRoutePlan({
        prompt: '请依据公司差旅报销制度说明发票审批流程', user: { id: 7 }, availableMcpTools: [dbTool],
        state: { ragEnabled: true, mcpEnabled: false, autoRouteEnabled: true }
    });
    assert.equal(knowledge.rag.action, 'retrieve');
    assert.equal(calls.collections, 1);

    const data = await router.resolveRoutePlan({
        prompt: '查询本月订单数量并按状态汇总', user: { id: 7 }, availableMcpTools: [dbTool],
        state: { ragEnabled: true, mcpEnabled: false, autoRouteEnabled: true }
    });
    assert.equal(data.tools.action, 'candidate_only');
    assert.equal(requiresMcpConsentForRoute(data, false), true);
    assert.equal(calls.tools, 1);
});

test('真实外部操作会唤醒工具路由，普通通知文案保持直接回答', async () => {
    const notifyTool = {
        fullName: 'mcp.0.im.send_message', name: 'im.send_message', serverName: '消息服务',
        serverType: 'im', description: '向指定人员发送即时通知'
    };
    const { router } = routerForTests({ tools: [notifyTool] });
    const draft = await router.resolveRoutePlan({
        prompt: '帮我写一封项目延期通知邮件', user: { id: 7 }, availableMcpTools: [notifyTool],
        state: { ragEnabled: true, mcpEnabled: false, autoRouteEnabled: true }
    });
    assert.equal(draft.tools.action, 'skip');
    const send = await router.resolveRoutePlan({
        prompt: '请发送项目延期通知给相关人员', user: { id: 7 }, availableMcpTools: [notifyTool],
        state: { ragEnabled: true, mcpEnabled: false, autoRouteEnabled: true }
    });
    assert.equal(send.tools.action, 'candidate_only');
    assert.equal(requiresMcpConsentForRoute(send, false), true);
});

test('报告、图表、API 与 MCP 教学或代码示例保持直接回答，不请求工具授权', async () => {
    const tools = [
        { fullName: 'mcp.0.report.compose', name: 'report.compose', serverName: '报告服务', description: '生成固定模板报告文档' },
        { fullName: 'mcp.0.viz.build_chart', name: 'viz.build_chart', serverName: '图表服务', description: '生成交互式图表' },
        { fullName: 'mcp.0.api.orders', name: 'api.orders', serverName: '订单接口', description: '调用订单 API 查询实时状态' },
        { fullName: 'mcp.0.db.run_readonly_query', name: 'db.run_readonly_query', serverName: '数据库服务', description: '执行只读 SQL 查询' }
    ];
    const { router } = routerForTests({ tools });
    const prompts = [
        '帮我生成一份季度经营分析报告',
        '请把下面三个数字画成柱状图：10、20、30',
        '给我一个调用订单 API 的 JavaScript 示例',
        '解释如何调用 MCP 工具查询数据',
        '请用 SQL 统计用户表，给一个示例'
    ];
    for (const prompt of prompts) {
        const plan = await router.resolveRoutePlan({
            prompt, user: { id: 7 }, availableMcpTools: tools,
            state: { ragEnabled: true, mcpEnabled: false, autoRouteEnabled: true }
        });
        assert.equal(plan.tools.action, 'skip', `Prompt "${prompt}" should remain a direct answer`);
        assert.equal(requiresMcpConsentForRoute(plan, false), false);
    }
});

test('英文受控资料与实时数据请求同样按需唤醒对应路由', async () => {
    const dbTool = {
        fullName: 'mcp.0.db.run_readonly_query', name: 'db.run_readonly_query', serverName: 'Sales database',
        serverType: 'database', description: 'Query orders and sales data'
    };
    const { router } = routerForTests({
        collections: [{ collectionId: 12, name: 'Internal travel policy', description: 'Travel expense approvals and invoice rules', domainTags: [], vector: [] }],
        tools: [dbTool]
    });
    assert.equal(requiresKnowledgeRetrieval('Search the internal knowledge base for our travel expense policy.'), true);
    const knowledge = await router.resolveRoutePlan({
        prompt: 'Search the internal knowledge base for our travel expense policy.', user: { id: 7 }, availableMcpTools: [dbTool],
        state: { ragEnabled: true, mcpEnabled: false, autoRouteEnabled: true }
    });
    assert.equal(knowledge.rag.action, 'retrieve');
    const data = await router.resolveRoutePlan({
        prompt: 'Query the sales database and summarize orders by status.', user: { id: 7 }, availableMcpTools: [dbTool],
        state: { ragEnabled: true, mcpEnabled: false, autoRouteEnabled: true }
    });
    assert.equal(data.tools.action, 'candidate_only');
});
