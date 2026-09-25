const { getContext } = require('../llm');
const { readTypedEnv } = require('../config/env-registry');
const { shouldDisableChatThinking } = require('./models');
const {
    ContextLengthExceededError,
    buildContextLengthExceededPayload,
    fitMessagesToContextBudget,
    getModelContextBudget
} = require('./context-budget');
const { getRequestOrigin, resolveRagQueryContent } = require('./chat-route-helpers');
const {
    buildRagInsufficientContextMessage,
    injectRagContextBeforeLatestUser,
    summarizeRagContextSources
} = require('./chat-rag-context');
const { saveUserMessage } = require('./chat-messages');
const { buildVisionHistory, limitVisionImages } = require('./chat-vision');
const { listCachedMcpTools } = require('./mcp-client');
const { filterMcpToolsByCapability } = require('./capability-market');
const { maybeBuildMcpChatContext } = require('./chat-mcp-context');
const { resolveRoutePlan, buildRouteMetadata, buildRouteSseEvent } = require('./semantic-router');
const { buildAgentAuditFields, buildWorldStatePrompt } = require('./agent-step-context');
const { createPersistedChatStepContext } = require('./chat-context-state-store');
const {
    buildLongTermMemoryContextMessage,
    compareMemoryRetrievalShadow,
    injectLongTermMemoryBeforeLatestUser,
    recordMemoryUsage,
    retrieveLongTermMemories
} = require('./long-term-memory');
const { buildStructuredTaskState } = require('./structured-task-state');
const {
    applyChatLanguageInstruction,
    applyChatNoThinkSoftSwitch,
    hasRagScopeFilter
} = require('./chat-helpers');

function buildMcpFollowupInstruction(mcpContext = '') {
    const hasToolResult = String(mcpContext || '').includes('PIVOT_MCP_TOOL_RESULT_BEGIN');
    if (hasToolResult) {
        return [
            '请基于上面的 PIVOT_MCP_TOOL_RESULT_BEGIN 工具库结果回答我刚才的问题。',
            '这些结果是本轮最新事实，优先于长期记忆、历史对话和模型常识。',
            '如果工具结果来自本机报表目录或 mcp.0，本轮已经通过授权通道访问了本机资源；不得声称无法访问本机文件系统或要求用户自行查看目录。',
            '若工具结果不足，只说明结果不足，并列出仍缺少的信息。'
        ].join('\n');
    }
    return [
        '请结合上面的 PIVOT_MCP_CONTEXT_BEGIN 工具库上下文回答我刚才的问题。',
        '不要忽略工具库上下文，也不要用长期记忆或历史对话覆盖本轮工具库状态。',
        '只有当工具库上下文明示工具未执行、失败或缺少授权时，才说明无法完成对应的实时工具查询。'
    ].join('\n');
}

function appendMcpContextForFinalAnswer(history = [], mcpContext = '') {
    if (!mcpContext) return history;
    const normalizedContext = [
        'PIVOT_MCP_CONTEXT_BEGIN',
        String(mcpContext),
        'PIVOT_MCP_CONTEXT_END'
    ].join('\n');
    return [
        ...history,
        { role: 'assistant', content: normalizedContext },
        { role: 'user', content: buildMcpFollowupInstruction(mcpContext) }
    ];
}

function requiresMcpConsentForRoute(routePlan = {}, mcpEnabled = false) {
    if (mcpEnabled || routePlan?.shadow === true) return false;
    const candidates = Array.isArray(routePlan?.tools?.candidates) ? routePlan.tools.candidates : [];
    return routePlan?.tools?.action === 'candidate_only'
        && candidates.some(candidate => String(candidate?.fullName || candidate?.name || '').trim());
}

function filterChatMcpToolsByAllowlist(tools = [], allowlist = null) {
    if (!Array.isArray(allowlist)) return tools;
    const allowed = new Set(allowlist.map(value => String(value || '').trim()).filter(Boolean));
    return tools.filter(tool => allowed.has(String(tool?.fullName || '').trim()));
}


const MAX_CHAT_TOOL_CANDIDATES = 8;

function pruneChatToolCandidates(tools = [], taskState = {}, max = MAX_CHAT_TOOL_CANDIDATES) {
    const source = Array.isArray(tools) ? tools : [];
    if (source.length <= max) return source;
    const intent = taskState?.toolIntent || {};
    const requested = new Set(Array.isArray(intent.requestedCapabilities) ? intent.requestedCapabilities : []);
    const needsLocal = intent.requiresLocalFiles === true || requested.has('filesystem.read_workspace');
    const needsBrowser = requested.has('browser.inspect');
    const needsData = requested.has('data.query');
    const score = tool => {
        const name = String(tool?.name || tool?.fullName || '').toLowerCase();
        const fullName = String(tool?.fullName || '').toLowerCase();
        let value = 0;
        if (needsLocal && (name.startsWith('reports.') || fullName.startsWith('mcp.0.reports.'))) value += 100;
        if (needsBrowser && name.startsWith('browser.')) value += 100;
        if (needsData && (name.startsWith('db.') || name.includes('query') || name.includes('table'))) value += 90;
        if (requested.has('side_effect') && (tool?.side_effect || /notify|send|write|export/.test(name))) value += 40;
        if (tool?.localDevice?.online === true) value += 5;
        if (tool?.source === 'builtin') value += 2;
        return value;
    };
    return source.slice().sort((left, right) => score(right) - score(left)
        || String(left?.fullName || left?.name || '').localeCompare(String(right?.fullName || right?.name || ''))).slice(0, max);
}

async function assembleChatContext({
    req,
    state,
    modelCfg,
    retrieveContext,
    isRagEnabled,
    publicUrl = '',
    writeSse,
    releaseSemaphore,
    writeChatErrorSse,
    persistOnError = false,
    signal = null
}) {
    const { sessionId, userId, modelId, modelContent, ragEnabled, ragScope, mcpEnabled, mcpToolAllowlist } = state;
    let history = await getContext(sessionId, userId, modelCfg, { user: req.user, signal });
    let pendingMemoryUsage = null;
    const disableChatThinking = shouldDisableChatThinking(modelCfg);
    // 检索只使用本轮结构化任务状态中的 currentQuestion/retrievalQuery，
    // 不把完整聊天记录直接作为知识库或工具路由查询。完整 history 仅用于最终回答上下文。
    const effectiveUserPrompt = resolveRagQueryContent(modelContent, history);
    const taskState = buildStructuredTaskState({
        prompt: effectiveUserPrompt || modelContent,
        previousState: state.taskState || null,
        scope: state.ragScope || {},
        routeOverrides: state.routeOverrides || {}
    });
    const retrievalQuery = taskState.retrievalQuery || effectiveUserPrompt || modelContent;
    const memoryQuery = retrievalQuery;


    // 工具目录的可见性、治理与白名单在路由前完成；路由器只能缩小该集合，
    // 永远不能重新引入无权或用户未允许的工具。
    let accessibleMcpTools = [];
    if (mcpEnabled || state.autoRouteEnabled === true) {
        try {
            const capabilityFiltered = await filterMcpToolsByCapability(await listCachedMcpTools(null, req.user), req.user);
            accessibleMcpTools = filterChatMcpToolsByAllowlist(capabilityFiltered, mcpToolAllowlist);
        } catch (error) {
            req.log.warn({ sessionId, userId, err: error.message }, '读取工具目录失败，已按无工具候选继续');
        }
    }

    let routePlan;
    try {
        routePlan = await resolveRoutePlan({
            prompt: retrievalQuery,
            taskState,
            user: req.user,
            state,
            availableMcpTools: accessibleMcpTools,
            signal
        });
        writeSse(JSON.stringify(buildRouteSseEvent(routePlan)));
    } catch (error) {
        // 路由是增强层，任何初始化或外部 Embedding 异常均不可中断原有聊天。
        req.log.warn({ sessionId, userId, err: error.message }, '自适应路由不可用，已回退原有聊天链路');
        const fallbackToolCandidates = pruneChatToolCandidates(accessibleMcpTools, taskState);
        routePlan = {
            mode: 'legacy',
            shadow: false,
            rag: { action: ragEnabled ? 'retrieve' : 'skip', scope: ragScope || {}, collections: [], confidence: 0, reasonCode: 'router_fallback' },
            tools: {
                action: mcpEnabled ? 'propose' : (fallbackToolCandidates.length ? 'candidate_only' : 'skip'),
                candidates: fallbackToolCandidates,
                candidateTools: fallbackToolCandidates,
                confidence: 0,
                reasonCode: 'router_fallback'
            },
            execution: {
                rag: { shouldRetrieve: Boolean(ragEnabled), scope: ragScope || {}, queryVector: null },
                tools: { shouldPlan: Boolean(mcpEnabled && fallbackToolCandidates.length), candidates: fallbackToolCandidates }
            },
            timing: { routeDurationMs: 0, embeddingDurationMs: 0 }
        };
        writeSse(JSON.stringify(buildRouteSseEvent(routePlan)));
    }

    // 工具库首次使用需要用户在前端确认。此处在完成路由后立即暂停，
    // 既不会调用模型生成一份无工具的重复回答，也不会执行任何工具。
    // 前端确认后以 regenerate 复用已保存的同一条用户消息继续本轮请求。
    if (requiresMcpConsentForRoute(routePlan, mcpEnabled)) {
        return {
            routePlan,
            mcpConsentRequired: true
        };
    }

    const effectiveRagScope = routePlan.execution?.rag?.scope || ragScope || {};
    const routeQueryVector = Array.isArray(routePlan.execution?.rag?.queryVector)
        ? routePlan.execution.rag.queryVector
        : null;

    const shouldRetrieveRag = Boolean(routePlan.execution?.rag?.shouldRetrieve)
        && typeof retrieveContext === 'function'
        && typeof isRagEnabled === 'function'
        && isRagEnabled()
        && Boolean(retrievalQuery);
    const [memoryResult, ragResult] = await Promise.allSettled([
        memoryQuery ? retrieveLongTermMemories(userId, memoryQuery, { user: req.user, sessionId }) : Promise.resolve([]),
        shouldRetrieveRag ? retrieveContext(userId, retrievalQuery, null, {
            user: req.user,
            scope: effectiveRagScope,
            ...(routeQueryVector?.length ? { queryVector: routeQueryVector } : {})
        }) : Promise.resolve(null)
    ]);

    if (!shouldRetrieveRag && taskState.evidenceNeeds.includes('knowledge_base')) {
        history = injectRagContextBeforeLatestUser(history, buildRagInsufficientContextMessage(ragEnabled ? 'rag_not_selected' : 'rag_disabled'));
        writeSse(JSON.stringify({
            type: 'rag',
            status: 'rejected',
            message: '本轮问题需要知识库依据，但当前没有可用的知识库检索结果，将拒绝无来源补答。',
            reason: ragEnabled ? 'rag_not_selected' : 'rag_disabled'
        }));
    }

    if (memoryQuery) {
        try {
            if (memoryResult.status === 'rejected') throw memoryResult.reason;
            const memoryMatches = memoryResult.value || [];
            const memoryMessage = buildLongTermMemoryContextMessage(memoryMatches, {
                inputBudget: getModelContextBudget(modelCfg).inputBudget
            });
            if (memoryMessage) {
                history = injectLongTermMemoryBeforeLatestUser(history, memoryMessage);
                pendingMemoryUsage = {
                    matches: memoryMatches.filter(memory => memoryMessage.metadata?.memoryIds?.includes(memory.id)),
                    queryText: memoryQuery
                };
                if (readTypedEnv('PIVOT_LONG_TERM_MEMORY_SHADOW_MODE')) {
                    void compareMemoryRetrievalShadow(userId, memoryQuery, memoryMatches, {
                        user: req.user,
                        sessionId,
                        limit: memoryMatches.length
                    }).catch(error => req.log.warn({ sessionId, userId, err: error.message }, '长期记忆影子排序比较失败'));
                }
                writeSse(JSON.stringify({
                    type: 'memory',
                    status: 'hit',
                    message: `已检索到 ${memoryMatches.length} 条相关长期记忆`,
                    memoryCount: memoryMatches.length
                    ,usageReasons: memoryMessage.metadata?.usageReasons || []
                }));
            }
        } catch (err) {
            req.log.warn({ sessionId, userId, err: err.message }, '长期记忆检索失败，已按普通上下文继续');
        }
    }

    if (shouldRetrieveRag) {
        const ragContext = ragResult.status === 'fulfilled' ? ragResult.value : null;
        const ragScoped = hasRagScopeFilter(effectiveRagScope);
        const ragScopeText = ragScoped ? '（当前选择范围）' : '';
        if (ragContext) {
            const ragSourceSummary = summarizeRagContextSources(ragContext);
            const sourceCount = Number(ragSourceSummary.sourceCount || 0);
            const citationCount = Number(ragSourceSummary.citationCount || 0);
            const ragHitCountText = sourceCount > 0
                ? `${sourceCount} 份可引用文档${citationCount > sourceCount ? `（${citationCount} 条引用片段）` : ''}`
                : `${citationCount} 条资料`;
            history = injectRagContextBeforeLatestUser(history, ragContext);
            writeSse(JSON.stringify({
                type: 'rag',
                status: 'hit',
                message: ragSourceSummary.sourceCount > 0
                    ? `知识库${ragScopeText}已找到 ${ragHitCountText}，正在基于来源生成回答`
                    : `知识库${ragScopeText}已找到相关资料，正在基于资料生成回答`,
                citationCount: ragSourceSummary.citationCount,
                sourceCount: ragSourceSummary.sourceCount,
                sources: ragSourceSummary.sources,
                citationKeys: ragSourceSummary.citationKeys || [],
                scoped: ragScoped
            }));
        } else {
            const requiresKnowledgeEvidence = Array.isArray(taskState.evidenceNeeds)
                && taskState.evidenceNeeds.includes('knowledge_base');
            if (requiresKnowledgeEvidence) {
                const rejectionReason = ragResult.status === 'rejected'
                    ? String(ragResult.reason || 'low_confidence').slice(0, 120)
                    : 'no_reliable_match';
                history = injectRagContextBeforeLatestUser(history, buildRagInsufficientContextMessage(rejectionReason));
            }
            writeSse(JSON.stringify({
                type: 'rag',
                status: requiresKnowledgeEvidence ? 'rejected' : 'empty',
                message: requiresKnowledgeEvidence
                    ? `知识库${ragScopeText}没有达到可信度门槛的依据，本轮将拒绝无来源补答`
                    : `知识库${ragScopeText}未检索到足够相关内容`,
                reason: requiresKnowledgeEvidence ? 'insufficient_evidence' : 'no_reliable_match',
                scoped: ragScoped
            }));
        }
    }

    let visionHistory = limitVisionImages(await buildVisionHistory(history, getRequestOrigin(req, publicUrl), userId, sessionId));
    visionHistory = applyChatLanguageInstruction(visionHistory);

    if (visionHistory.length === 0) {
        req.log.warn({ sessionId, userId }, '检测到空的消息历史，尝试补救');
        if (modelContent) {
            req.log.info({ sessionId }, '执行补救措施：将丢失的用户消息存入数据库并加入当前上下文');
            try {
                await saveUserMessage({ sessionId, userId, content: modelContent, modelId });
            } catch (dbErr) {
                req.log.error({ err: dbErr.message }, '补救消息入库失败');
            }
            const rescuedHistory = limitVisionImages(await buildVisionHistory([{ role: 'user', content: modelContent }], getRequestOrigin(req, publicUrl), userId, sessionId));
            visionHistory.push(...rescuedHistory);
        } else {
            releaseSemaphore?.();
            await writeChatErrorSse({
                writeSse,
                sessionId,
                userId,
                modelId: modelCfg.id,
                error: '对话内容不能为空',
                code: 'EMPTY_MESSAGE',
                persist: persistOnError,
                log: req.log
            });
            return { errorEnded: true };
        }
    }

    let chatMcpTools = [];
    if (mcpEnabled) {
        const mcpTools = Array.isArray(routePlan.execution?.tools?.candidates)
            ? routePlan.execution.tools.candidates
            : accessibleMcpTools;
        chatMcpTools = mcpTools;
        const mcpContext = await maybeBuildMcpChatContext({
            modelCfg,
            history: visionHistory,
            userPrompt: taskState.currentQuestion || retrievalQuery,
            taskState,
            tools: mcpTools,
            user: req.user,
            writeSse,
            log: req.log,
            localMcpBridgeDebug: req.localMcpBridgeDebug || req.body?.localMcpBridgeDebug || null,
            signal
        });
        if (mcpContext) {
            visionHistory = appendMcpContextForFinalAnswer(visionHistory, mcpContext);
        }
    }

    let chatStepContext = null;
    try {
        chatStepContext = await createPersistedChatStepContext({
            sessionId,
            user: req.user,
            modelCfg,
            toolList: chatMcpTools,
            turnId: `${sessionId}:chat:${Date.now()}`,
            stepIndex: Number(history.length || 0),
            contextConfig: {
                goal: taskState.goal || String(modelContent || '').slice(0, 4000),
                currentQuestion: taskState.currentQuestion,
                retrievalQuery: taskState.retrievalQuery,
                taskState,
                ragEnabled: Boolean(ragEnabled),
                mcpEnabled: Boolean(mcpEnabled),
                mcpToolAllowlist: Array.isArray(mcpToolAllowlist) ? mcpToolAllowlist : [],
                route: buildRouteMetadata(routePlan),
                historyMessageCount: history.length,
                networkPolicy: { enabled: true }
            },
            environment: { entrypoint: 'chat', userAgent: req.get?.('user-agent') || '' },
            memory: { enabled: true, hasSummary: history.some(message => message?.is_summary === 1 || message?.context_archived === 1) },
            contextCompacted: history.some(message => message?.is_summary === 1 || message?.context_archived === 1),
            taskState
        });
        visionHistory = [
            { role: 'system', content: buildWorldStatePrompt(chatStepContext.worldState, { injection: chatStepContext.worldStateInjection }) },
            ...visionHistory
        ];
        writeSse(JSON.stringify({
            type: 'context',
            status: 'captured',
            ...buildAgentAuditFields(chatStepContext, { entrypoint: 'chat', purpose: 'chat_context_captured' }),
            injectionMode: chatStepContext.worldStateInjection?.mode || 'full'
        }));
    } catch (error) {
        req.log.warn({ sessionId, userId, err: error.message }, '聊天上下文窗口持久化失败，继续使用内存上下文');
    }

    visionHistory = applyChatNoThinkSoftSwitch(visionHistory, modelCfg);

    try {
        const budgetResult = fitMessagesToContextBudget(visionHistory, modelCfg);
        visionHistory = budgetResult.messages;
        if (pendingMemoryUsage?.matches?.length) {
            const memoryPresent = visionHistory.some(message => String(message?.content || '').includes('PIVOT_LONG_TERM_MEMORY_BEGIN'));
            const trimmed = !memoryPresent
                || Number(budgetResult.metadata.trimmedMemoryContexts || 0) > 0
                || Number(budgetResult.metadata.droppedMemoryContexts || 0) > 0;
            try {
                await recordMemoryUsage(userId, pendingMemoryUsage.matches, {
                    eventType: trimmed ? 'trimmed' : 'injected',
                    sessionId,
                    queryText: pendingMemoryUsage.queryText,
                    reason: trimmed ? 'context_budget_trimmed' : ''
                });
            } catch (error) {
                req.log.warn({ sessionId, userId, err: error.message }, '长期记忆实际注入事件记录失败');
            }
        }
        if (budgetResult.metadata.adjusted) {
            req.log.warn({
                sessionId,
                userId,
                modelId: modelCfg.id,
                contextBudget: budgetResult.metadata
            }, '聊天上下文已按模型窗口自动裁剪');
            writeSse(JSON.stringify({
                type: 'context_budget',
                status: 'trimmed',
                message: '本次请求内容较长，已自动减少较早历史或知识库片段后继续生成。',
                contextBudget: budgetResult.metadata
            }));
        } else {
            req.log.info({
                sessionId,
                userId,
                modelId: modelCfg.id,
                inputTokens: budgetResult.metadata.inputTokensAfter,
                inputBudget: budgetResult.metadata.budget.inputBudget
            }, '聊天上下文预算检查通过');
        }
    } catch (e) {
        releaseSemaphore?.();
        if (e instanceof ContextLengthExceededError || e.code === 'CONTEXT_LENGTH_EXCEEDED') {
            req.log.warn({
                sessionId,
                userId,
                modelId: modelCfg.id,
                contextBudget: e.metadata
            }, '聊天请求因上下文超限被拦截');
            const payload = buildContextLengthExceededPayload(e);
            await writeChatErrorSse({
                writeSse,
                sessionId,
                userId,
                modelId: modelCfg.id,
                error: payload.error,
                detail: payload.detail,
                code: payload.code,
                persist: persistOnError,
                log: req.log
            });
            return { errorEnded: true };
        }
        throw e;
    }

    return {
        visionHistory,
        effectiveUserPrompt,
        disableChatThinking,
        chatStepContext,
        routePlan
    };
}

module.exports = {
    appendMcpContextForFinalAnswer,
    assembleChatContext,
    buildMcpFollowupInstruction,
    filterChatMcpToolsByAllowlist,
    requiresMcpConsentForRoute,
    pruneChatToolCandidates
};
