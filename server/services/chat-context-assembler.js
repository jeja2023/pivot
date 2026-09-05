const { getContext } = require('../llm');
const { shouldDisableChatThinking } = require('./models');
const {
    ContextLengthExceededError,
    buildContextLengthExceededPayload,
    fitMessagesToContextBudget,
    getModelContextBudget
} = require('./context-budget');
const { getRequestOrigin, resolveRagQueryContent } = require('./chat-route-helpers');
const { injectRagContextBeforeLatestUser, summarizeRagContextSources } = require('./chat-rag-context');
const { saveUserMessage } = require('./chat-messages');
const { buildVisionHistory, limitVisionImages } = require('./chat-vision');
const { listCachedMcpTools } = require('./mcp-client');
const { filterMcpToolsByCapability } = require('./capability-market');
const { maybeBuildMcpChatContext } = require('./chat-mcp-context');
const { buildAgentAuditFields, buildWorldStatePrompt } = require('./agent-step-context');
const { createPersistedChatStepContext } = require('./chat-context-state-store');
const {
    buildLongTermMemoryContextMessage,
    injectLongTermMemoryBeforeLatestUser,
    retrieveLongTermMemories
} = require('./long-term-memory');
const {
    applyChatLanguageInstruction,
    applyChatNoThinkSoftSwitch,
    hasRagScopeFilter
} = require('../routes/chat/helpers');

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

function filterChatMcpToolsByAllowlist(tools = [], allowlist = null) {
    if (!Array.isArray(allowlist)) return tools;
    const allowed = new Set(allowlist.map(value => String(value || '').trim()).filter(Boolean));
    return tools.filter(tool => allowed.has(String(tool?.fullName || '').trim()));
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
    const disableChatThinking = shouldDisableChatThinking(modelCfg);
    const effectiveUserPrompt = resolveRagQueryContent(modelContent, history);
    const memoryQuery = effectiveUserPrompt || modelContent;

    if (memoryQuery) {
        try {
            const memoryMatches = await retrieveLongTermMemories(userId, memoryQuery, { user: req.user });
            const memoryMessage = buildLongTermMemoryContextMessage(memoryMatches, {
                inputBudget: getModelContextBudget(modelCfg).inputBudget
            });
            if (memoryMessage) {
                history = injectLongTermMemoryBeforeLatestUser(history, memoryMessage);
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

    if (ragEnabled && typeof retrieveContext === 'function' && typeof isRagEnabled === 'function' && isRagEnabled()) {
        const ragContext = effectiveUserPrompt ? await retrieveContext(userId, effectiveUserPrompt, null, { user: req.user, scope: ragScope }) : null;
        const ragScoped = hasRagScopeFilter(ragScope);
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
                scoped: ragScoped
            }));
        } else {
            writeSse(JSON.stringify({
                type: 'rag',
                status: 'empty',
                message: `知识库${ragScopeText}未检索到足够相关内容，将按普通对话继续`,
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
        const accessibleMcpTools = await filterMcpToolsByCapability(await listCachedMcpTools(null, req.user), req.user);
        const mcpTools = filterChatMcpToolsByAllowlist(accessibleMcpTools, mcpToolAllowlist);
        chatMcpTools = mcpTools;
        const mcpContext = await maybeBuildMcpChatContext({
            modelCfg,
            history: visionHistory,
            userPrompt: effectiveUserPrompt || modelContent,
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
                goal: String(modelContent || '').slice(0, 4000),
                ragEnabled: Boolean(ragEnabled),
                mcpEnabled: Boolean(mcpEnabled),
                mcpToolAllowlist: Array.isArray(mcpToolAllowlist) ? mcpToolAllowlist : [],
                historyMessageCount: history.length,
                networkPolicy: { enabled: true }
            },
            environment: { entrypoint: 'chat', userAgent: req.get?.('user-agent') || '' },
            memory: { enabled: true, hasSummary: history.some(message => message?.is_summary === 1 || message?.context_archived === 1) },
            contextCompacted: history.some(message => message?.is_summary === 1 || message?.context_archived === 1)
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
        chatStepContext
    };
}

module.exports = {
    appendMcpContextForFinalAnswer,
    assembleChatContext,
    buildMcpFollowupInstruction,
    filterChatMcpToolsByAllowlist
};
