const crypto = require('crypto');
const { getEmbeddingConfig } = require('./rag-config');
const { generateEmbedding, cosineSimilarity, normalizeRetrievalScope } = require('./rag-index');
const knowledgeCatalogIndex = require('./knowledge-catalog-index');
const mcpToolCatalogIndex = require('./mcp-tool-catalog-index');
const { getChatAutoRouteConfig } = require('./chat-route-config');
const { recordChatRouteMetric } = require('./chat-route-observability');
const {
    detectBrowserVisitIntent,
    detectExplicitMcpCapabilityIntent,
    detectReportFileInventoryIntent,
    detectStrongDataQueryIntent
} = require('./chat-mcp-context');
const { logger } = require('../logger');

const MAX_ROUTE_OVERRIDE_COLLECTIONS = 50;
const MAX_ROUTE_OVERRIDE_TOOLS = 100;

function normalizeBoolean(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(text)) return true;
    if (['false', '0', 'no', 'off'].includes(text)) return false;
    return fallback;
}

function normalizeCollectionIds(value, max = MAX_ROUTE_OVERRIDE_COLLECTIONS) {
    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values
        .map(item => Number.parseInt(item, 10))
        .filter(item => Number.isSafeInteger(item) && item > 0))]
        .slice(0, max);
}

function normalizeToolNames(value, max = MAX_ROUTE_OVERRIDE_TOOLS) {
    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values
        .map(item => String(item || '').trim())
        .filter(item => /^mcp\.\d+\.[A-Za-z0-9_.-]{1,180}$/.test(item)))]
        .slice(0, max);
}

function normalizeRouteOverrides(value = {}) {
    const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        collections: normalizeCollectionIds(raw.collections ?? raw.collectionIds),
        tools: normalizeToolNames(raw.tools ?? raw.toolNames),
        excludedTools: normalizeToolNames(raw.excludedTools ?? raw.excludeTools),
        excludeRag: normalizeBoolean(raw.excludeRag ?? raw.disableRag, false),
        excludeTools: normalizeBoolean(raw.excludeTools ?? raw.disableTools, false)
    };
}

function routePromptHash(prompt = '') {
    return `sha256:${crypto.createHash('sha256').update(String(prompt || '')).digest('hex')}`;
}

function normalizeRoutePrompt(value = '') {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 16000);
}

function lexicalTokens(value = '') {
    const text = String(value || '').toLowerCase();
    const tokens = new Set();
    (text.match(/[a-z0-9_./-]{2,}/g) || []).forEach(token => tokens.add(token));
    const chinese = text.replace(/[^\u4e00-\u9fff]/g, '');
    for (let index = 0; index < chinese.length - 1; index += 1) tokens.add(chinese.slice(index, index + 2));
    return tokens;
}

function lexicalSimilarity(left = '', right = '') {
    const leftTokens = lexicalTokens(left);
    const rightTokens = lexicalTokens(right);
    if (!leftTokens.size || !rightTokens.size) return 0;
    let shared = 0;
    for (const token of leftTokens) {
        if (rightTokens.has(token)) shared += 1;
    }
    return shared / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
}

function isConversationOnlyPrompt(prompt = '') {
    const text = normalizeRoutePrompt(prompt);
    if (!text) return true;
    if (/^(?:你好|您好|嗨|在吗|谢谢|感谢|再见|晚安|早上好|下午好)[！!。,.，？?]*$/u.test(text)) return true;
    return /(?:^|\s)(?:翻译|润色|改写|续写|写一封|写个|起草|总结以下内容)(?:\s|$)/u.test(text)
        && !/(?:制度|流程|规定|政策|手册|资料库|知识库|数据库|数据表|文件|报表|工具|mcp)/iu.test(text);
}

function toolText(tool = {}) {
    return [tool.fullName, tool.name, tool.serverName, tool.serverType, tool.description]
        .map(value => String(value || '').toLowerCase())
        .join(' ');
}

function isDataTool(tool = {}) {
    return /(?:\bdb\.|database|query|readonly|sql|table|collection|duckdb|数据|查询|统计)/iu.test(toolText(tool));
}

function isReportTool(tool = {}) {
    return /(?:report|reports\.|报表|文件|目录|file)/iu.test(toolText(tool));
}

function isBrowserTool(tool = {}) {
    return /(?:browser|浏览器|网页|web)/iu.test(toolText(tool));
}

function isChartTool(tool = {}) {
    return /(?:viz\.|chart|graph|visual|图表|可视化|绘图)/iu.test(toolText(tool));
}

function toolRuleScore(tool, prompt, overrides = {}) {
    const fullName = String(tool?.fullName || '');
    if (overrides.tools.includes(fullName)) return 1;
    const strongData = detectStrongDataQueryIntent(prompt);
    const report = detectReportFileInventoryIntent(prompt);
    const browser = detectBrowserVisitIntent(prompt);
    const chart = /(?:图表|趋势图|柱状图|折线图|饼图|可视化|画图|绘图|chart|graph|plot)/iu.test(prompt);
    if (strongData && isDataTool(tool)) return 1;
    if (report && isReportTool(tool)) return 1;
    if (browser && isBrowserTool(tool)) return 1;
    if (chart && isChartTool(tool)) return 0.9;
    if (detectExplicitMcpCapabilityIntent(prompt)) return 0.35;
    const serverName = String(tool?.serverName || '').trim().toLowerCase();
    return serverName.length >= 2 && String(prompt || '').toLowerCase().includes(serverName) ? 0.5 : 0;
}

function safeScore(value) {
    return Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : 0;
}

function scoreCollection(entry, prompt, queryVector = []) {
    const lexical = lexicalSimilarity(prompt, `${entry.name || ''}\n${entry.description || ''}\n${(entry.domainTags || []).join(' ')}`);
    const semantic = Array.isArray(queryVector) && queryVector.length && Array.isArray(entry.vector) && entry.vector.length === queryVector.length
        ? safeScore(cosineSimilarity(queryVector, entry.vector))
        : 0;
    return {
        lexical,
        semantic,
        score: semantic > 0 ? safeScore(semantic * 0.8 + lexical * 0.2) : lexical
    };
}

function scoreTool(entry, prompt, queryVector = [], overrides = {}) {
    const lexical = lexicalSimilarity(prompt, entry.semanticSignature || '');
    const semantic = Array.isArray(queryVector) && queryVector.length && Array.isArray(entry.vector) && entry.vector.length === queryVector.length
        ? safeScore(cosineSimilarity(queryVector, entry.vector))
        : 0;
    const rule = toolRuleScore(entry.tool, prompt, overrides);
    const semanticScore = semantic > 0 ? safeScore(semantic * 0.75 + lexical * 0.25) : lexical;
    return {
        lexical,
        semantic,
        rule,
        score: safeScore(Math.max(rule, semanticScore))
    };
}

function buildLegacyExecution(state, tools = []) {
    return {
        rag: {
            shouldRetrieve: Boolean(state.ragEnabled),
            scope: normalizeRetrievalScope(state.ragScope || {}),
            queryVector: null
        },
        tools: {
            shouldPlan: Boolean(state.mcpEnabled),
            candidates: tools
        }
    };
}

function buildRouteMetadata(plan = {}) {
    const rawUsage = plan.providerUsage?.usage || plan.providerUsage || {};
    const cacheDetails = rawUsage?.input_tokens_details || rawUsage?.inputTokensDetails || rawUsage?.prompt_tokens_details || {};
    const cachedInputTokens = Number(cacheDetails.cached_tokens ?? cacheDetails.cachedTokens ?? 0) || 0;
    const cacheWriteTokens = Number(cacheDetails.cache_write_tokens ?? cacheDetails.cacheWriteTokens ?? 0) || 0;
    return {
        version: 1,
        mode: String(plan.mode || 'legacy'),
        shadow: plan.shadow === true,
        taskState: plan.taskState ? {
            hash: String(plan.taskState.hash || ''),
            evidenceNeeds: Array.isArray(plan.taskState.evidenceNeeds) ? plan.taskState.evidenceNeeds.slice(0, 8) : [],
            toolIntent: plan.taskState.toolIntent || {}
        } : null,
        rag: {
            action: String(plan.rag?.action || 'skip'),
            confidence: Number(plan.rag?.confidence || 0),
            reasonCode: String(plan.rag?.reasonCode || ''),
            collections: (plan.rag?.collections || []).map(item => ({
                id: Number(item.id),
                name: String(item.name || ''),
                confidence: Number(item.confidence || 0)
            }))
        },
        tools: {
            action: String(plan.tools?.action || 'skip'),
            confidence: Number(plan.tools?.confidence || 0),
            reasonCode: String(plan.tools?.reasonCode || ''),
            candidates: (plan.tools?.candidates || []).map(item => ({
                fullName: String(item.fullName || ''),
                name: String(item.name || ''),
                confidence: Number(item.confidence || 0)
            }))
        },
        timing: {
            routeDurationMs: Math.max(0, Math.round(Number(plan.timing?.routeDurationMs || 0))),
            embeddingDurationMs: Math.max(0, Math.round(Number(plan.timing?.embeddingDurationMs || 0)))
        },
        ...(cachedInputTokens > 0 || cacheWriteTokens > 0 ? {
            promptCache: { cachedInputTokens, cacheWriteTokens }
        } : {})
    };
}

function buildRouteSseEvent(plan = {}) {
    const metadata = buildRouteMetadata(plan);
    return {
        type: 'route',
        status: plan.shadow ? 'shadow' : 'resolved',
        ...metadata
    };
}

function createSemanticRouter(deps = {}) {
    const getConfig = deps.getChatAutoRouteConfig || getChatAutoRouteConfig;
    const getEmbedding = deps.getEmbeddingConfig || getEmbeddingConfig;
    const generateQueryEmbedding = deps.generateEmbedding || generateEmbedding;
    const catalogIndex = deps.knowledgeCatalogIndex || knowledgeCatalogIndex;
    const toolIndex = deps.mcpToolCatalogIndex || mcpToolCatalogIndex;
    const recordMetric = deps.recordChatRouteMetric || recordChatRouteMetric;

    async function resolveRoutePlan({ prompt, user, state = {}, availableMcpTools = [], signal = null, env = process.env } = {}) {
        const startedAt = Date.now();
        const config = getConfig(env);
        const structuredTaskState = state.taskState && typeof state.taskState === 'object' ? state.taskState : null;
        const cleanPrompt = normalizeRoutePrompt(structuredTaskState?.retrievalQuery || structuredTaskState?.currentQuestion || prompt);
        const overrides = normalizeRouteOverrides(state.routeOverrides);
        const legacyTools = Array.isArray(availableMcpTools) ? availableMcpTools : [];
        const legacyExecution = buildLegacyExecution(state, legacyTools);
        const autoRequested = state.autoRouteEnabled !== false;
        const routeEnabled = config.enabled && autoRequested;
        const shadow = routeEnabled && config.shadowMode;
        const explicitScope = normalizeRetrievalScope({
            ...(state.ragScope || {}),
            ...(overrides.collections.length ? { collectionIds: overrides.collections } : {})
        });
        const hasExplicitScope = Boolean(explicitScope.collectionIds.length || explicitScope.tagNames.length);
        const mode = !routeEnabled ? 'disabled' : shadow ? 'shadow' : (hasExplicitScope || overrides.tools.length || overrides.excludeRag || overrides.excludeTools) ? 'explicit' : 'auto';
        let queryVector = null;
        let embeddingDurationMs = 0;
        let embeddingError = '';
        const needAutoRag = routeEnabled && config.autoRagEnabled && state.ragEnabled && !hasExplicitScope && !overrides.excludeRag && !isConversationOnlyPrompt(cleanPrompt);
        const needAutoTools = routeEnabled && config.autoToolDiscoveryEnabled && !overrides.excludeTools && !isConversationOnlyPrompt(cleanPrompt);

        if ((needAutoRag || needAutoTools) && cleanPrompt) {
            const embeddingConfig = getEmbedding(user?.id || null);
            if (embeddingConfig?.http?.url) {
                const embeddingStartedAt = Date.now();
                try {
                    queryVector = await generateQueryEmbedding(cleanPrompt, null, embeddingConfig.http, user?.id || null, {
                        user,
                        signal,
                        timeoutMs: config.embeddingTimeoutMs,
                        source: 'chat_route_query'
                    });
                } catch (error) {
                    embeddingError = String(error?.code || error?.message || 'embedding_unavailable').slice(0, 120);
                    logger.warn({ err: error.message, userId: user?.id }, '对话自适应路由 Embedding 不可用，已安全降级');
                } finally {
                    embeddingDurationMs = Date.now() - embeddingStartedAt;
                }
            } else {
                embeddingError = 'embedding_not_configured';
            }
        }

        const rag = {
            action: 'skip',
            confidence: 0,
            reasonCode: '',
            collections: [],
            scope: explicitScope,
            queryVector,
            fallback: embeddingError ? 'lexical_or_skip' : 'none'
        };
        if (!state.ragEnabled || overrides.excludeRag) {
            rag.reasonCode = overrides.excludeRag ? 'explicit_rag_excluded' : 'rag_disabled';
        } else if (hasExplicitScope) {
            rag.action = 'retrieve';
            rag.reasonCode = 'explicit_rag_scope';
        } else if (!routeEnabled || !config.autoRagEnabled) {
            rag.action = 'retrieve';
            rag.reasonCode = 'legacy_rag_scope';
            rag.scope = normalizeRetrievalScope(state.ragScope || {});
        } else if (isConversationOnlyPrompt(cleanPrompt)) {
            rag.reasonCode = 'conversation_only';
        } else {
            try {
                const embeddingConfig = getEmbedding(user?.id || null);
                const entries = await catalogIndex.getVisibleEntries({ user, embeddingConfig });
                const scored = entries
                    .map(entry => ({ entry, ...scoreCollection(entry, cleanPrompt, queryVector || []) }))
                    .sort((left, right) => right.score - left.score || right.semantic - left.semantic)
                    .slice(0, config.maxCollections);
                const best = scored[0];
                const threshold = queryVector?.length ? config.ragThreshold : Math.min(config.ragThreshold, 0.34);
                const grayThreshold = queryVector?.length ? config.ragGrayThreshold : Math.min(config.ragGrayThreshold, 0.18);
                if (!entries.length) {
                    // 目录还未建成、刚升级或没有可用元数据时，不能因增强层让
                    // 原本的 RAG 消失；回到现有全范围检索，由底层访问控制兜底。
                    rag.action = 'retrieve';
                    rag.reasonCode = 'catalog_unavailable_fallback';
                    rag.scope = normalizeRetrievalScope(state.ragScope || {});
                } else if (best && best.score >= threshold) {
                    rag.action = 'retrieve';
                    rag.confidence = best.score;
                    rag.reasonCode = best.semantic > 0 ? 'collection_semantic_match' : 'collection_lexical_match';
                    rag.collections = scored.filter(item => item.score >= grayThreshold).map(item => ({
                        id: item.entry.collectionId,
                        name: item.entry.name,
                        confidence: item.score
                    }));
                    rag.scope = normalizeRetrievalScope({ collectionIds: rag.collections.map(item => item.id) });
                } else if (embeddingError) {
                    // HTTP Embedding 暂不可用时保持原链路可用性，不把“无法路由”
                    // 误判成“无需知识”。
                    rag.action = 'retrieve';
                    rag.confidence = best?.score || 0;
                    rag.reasonCode = 'embedding_fallback_legacy_rag';
                    rag.scope = normalizeRetrievalScope(state.ragScope || {});
                } else {
                    rag.confidence = best?.score || 0;
                    rag.reasonCode = best && best.score >= grayThreshold ? 'rag_low_confidence' : entries.length ? 'rag_no_match' : 'no_accessible_collection';
                }
                if (entries.some(entry => !Array.isArray(entry.vector) || entry.vector.length === 0)) {
                    catalogIndex.scheduleRefresh(entries, { user, embeddingConfig });
                }
            } catch (error) {
                rag.reasonCode = 'rag_router_error';
                logger.warn({ err: error.message, userId: user?.id }, '知识库自适应路由失败，已跳过自动范围缩小');
            }
        }

        const tools = {
            action: 'skip',
            confidence: 0,
            reasonCode: '',
            candidates: [],
            candidateTools: []
        };
        const explicitToolIntent = cleanPrompt ? detectExplicitMcpCapabilityIntent(cleanPrompt) : false;
        if (overrides.excludeTools) {
            tools.reasonCode = 'explicit_tool_excluded';
        } else if (!state.mcpEnabled && (!routeEnabled || !config.autoToolDiscoveryEnabled)) {
            tools.action = explicitToolIntent || overrides.tools.length ? 'candidate_only' : 'skip';
            tools.reasonCode = tools.action === 'candidate_only' ? 'mcp_consent_required' : 'mcp_disabled';
        } else if (state.mcpEnabled && (!routeEnabled || !config.autoToolDiscoveryEnabled)) {
            tools.action = 'propose';
            tools.reasonCode = 'legacy_tool_candidates';
            tools.candidateTools = legacyTools;
        } else {
            const excluded = new Set(overrides.excludedTools);
            let permitted = legacyTools.filter(tool => !excluded.has(String(tool?.fullName || '')));
            if (overrides.tools.length) {
                const requested = new Set(overrides.tools);
                permitted = permitted.filter(tool => requested.has(String(tool?.fullName || '')));
                tools.reasonCode = permitted.length ? 'explicit_tool_override' : 'explicit_tool_unavailable';
            }
            if (!permitted.length) {
                tools.reasonCode = tools.reasonCode || 'no_authorized_tool';
            } else {
                try {
                    const embeddingConfig = getEmbedding(user?.id || null);
                    const entries = toolIndex.getEntries(permitted, { embeddingConfig, userId: user?.id || null });
                    const scored = entries
                        .map(entry => ({ entry, ...scoreTool(entry, cleanPrompt, queryVector || [], overrides) }))
                        .sort((left, right) => right.score - left.score || right.rule - left.rule)
                        .slice(0, config.maxToolCandidates);
                    const best = scored[0];
                    const forced = overrides.tools.length > 0 || explicitToolIntent;
                    if (best && (forced || best.score >= config.toolThreshold)) {
                        tools.action = state.mcpEnabled ? 'propose' : 'candidate_only';
                        tools.confidence = best.score;
                        tools.reasonCode = tools.reasonCode || (best.rule > 0 ? 'tool_rule_match' : best.semantic > 0 ? 'tool_semantic_match' : 'tool_lexical_match');
                        tools.candidateTools = state.mcpEnabled ? scored.map(item => item.entry.tool) : [];
                        tools.candidates = scored.map(item => ({
                            fullName: String(item.entry.tool?.fullName || ''),
                            name: String(item.entry.tool?.name || item.entry.tool?.fullName || ''),
                            confidence: item.score,
                            reasonCode: item.rule > 0 ? 'rule_match' : item.semantic > 0 ? 'semantic_match' : 'lexical_match'
                        }));
                    } else {
                        tools.confidence = best?.score || 0;
                        tools.reasonCode = 'tool_no_match';
                    }
                    if (entries.some(entry => !Array.isArray(entry.vector) || entry.vector.length === 0)) {
                        toolIndex.scheduleRefresh(entries, { user, embeddingConfig });
                    }
                } catch (error) {
                    tools.reasonCode = 'tool_router_error';
                    logger.warn({ err: error.message, userId: user?.id }, '工具自适应路由失败，已回退现有工具候选链路');
                    tools.action = state.mcpEnabled ? 'propose' : 'candidate_only';
                    tools.candidateTools = state.mcpEnabled ? legacyTools : [];
                }
            }
        }

        if (!tools.candidates.length && tools.candidateTools.length) {
            tools.candidates = tools.candidateTools.slice(0, config.maxToolCandidates).map(tool => ({
                fullName: String(tool?.fullName || ''),
                name: String(tool?.name || tool?.fullName || ''),
                confidence: tools.confidence,
                reasonCode: tools.reasonCode
            }));
        }

        const plan = {
            version: 1,
            mode,
            shadow,
            query: { textHash: routePromptHash(cleanPrompt), source: structuredTaskState ? 'task_state.retrievalQuery' : 'current_prompt' },
            taskState: structuredTaskState ? {
                hash: String(structuredTaskState.hash || ''),
                evidenceNeeds: Array.isArray(structuredTaskState.evidenceNeeds) ? structuredTaskState.evidenceNeeds.slice(0, 8) : [],
                toolIntent: structuredTaskState.toolIntent || {}
            } : null,
            rag,
            tools,
            overrides,
            execution: shadow ? legacyExecution : {
                rag: {
                    shouldRetrieve: rag.action === 'retrieve',
                    scope: rag.scope,
                    queryVector: rag.queryVector
                },
                tools: {
                    shouldPlan: state.mcpEnabled && tools.action === 'propose',
                    candidates: tools.candidateTools
                }
            },
            timing: {
                routeDurationMs: Date.now() - startedAt,
                embeddingDurationMs
            }
        };
        recordMetric({
            routeMode: mode,
            ragAction: rag.action,
            toolAction: tools.action,
            routeDurationMs: plan.timing.routeDurationMs,
            embeddingDurationMs,
            ragCandidates: rag.collections.length,
            toolCandidates: tools.candidates.length,
            error: ['rag_router_error', 'tool_router_error'].includes(rag.reasonCode) || ['rag_router_error', 'tool_router_error'].includes(tools.reasonCode)
        });
        return plan;
    }

    return { resolveRoutePlan };
}

const defaultRouter = createSemanticRouter();

module.exports = {
    ...defaultRouter,
    buildRouteMetadata,
    buildRouteSseEvent,
    createSemanticRouter,
    isConversationOnlyPrompt,
    normalizeRouteOverrides,
    scoreTool
};
