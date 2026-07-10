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
    persistOnError = false
}) {
    const { sessionId, userId, modelId, modelContent, ragEnabled, ragScope, mcpEnabled } = state;
    let history = await getContext(sessionId, userId, modelCfg);
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
                saveUserMessage({ sessionId, userId, content: modelContent, modelId });
            } catch (dbErr) {
                req.log.error({ err: dbErr.message }, '补救消息入库失败');
            }
            const rescuedHistory = limitVisionImages(await buildVisionHistory([{ role: 'user', content: modelContent }], getRequestOrigin(req, publicUrl), userId, sessionId));
            visionHistory.push(...rescuedHistory);
        } else {
            releaseSemaphore?.();
            writeChatErrorSse({
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

    if (mcpEnabled) {
        const mcpTools = filterMcpToolsByCapability(listCachedMcpTools(null, req.user), req.user);
        const mcpContext = await maybeBuildMcpChatContext({
            modelCfg,
            history: visionHistory,
            userPrompt: effectiveUserPrompt || modelContent,
            tools: mcpTools,
            user: req.user,
            writeSse,
            log: req.log,
            localMcpBridgeDebug: req.localMcpBridgeDebug || req.body?.localMcpBridgeDebug || null
        });
        if (mcpContext) {
            visionHistory.push({ role: 'system', content: mcpContext });
        }
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
            writeChatErrorSse({
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
        disableChatThinking
    };
}

module.exports = {
    assembleChatContext
};
