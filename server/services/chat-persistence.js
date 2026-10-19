const { saveAssistantMessage, updateLastAssistantStats } = require('./chat-messages');
const { maybeGenerateTitle } = require('./chat-title');
const { scheduleMemoryExtraction } = require('./long-term-memory');
const { logger } = require('../logger');

async function persistAssistantTurn({
    sessionId,
    userId,
    userMessageId = null,
    user = null,
    modelCfg,
    visibleContent = '',
    assistantContent = '',
    assistantTokens = 0,
    costTime = null,
    tps = null,
    routeMetadata = null,
    skipMemoryExtraction = false,
    conversationTurnId = null
}) {
    const assistantMessageResult = await saveAssistantMessage({
        sessionId,
        userId,
        content: assistantContent,
        tokenCount: assistantTokens,
        modelId: modelCfg.id,
        routeMetadata: routeMetadata ? JSON.stringify(routeMetadata) : null,
        conversationTurnId
    });
    const assistantMessageId = Number(assistantMessageResult?.lastInsertRowid || 0) || null;
    if (costTime !== null || tps !== null) {
        await updateLastAssistantStats({ sessionId, userId, costTime, tps });
    }
    if (!skipMemoryExtraction) await scheduleMemoryExtraction({
        userId,
        sessionId,
        messageIds: [userMessageId, assistantMessageId].filter(Boolean),
        user,
        modelCfg
    }).catch(error => logger.warn({ sessionId, userId, code: error.code }, '自动记忆调度暂不可用，回答已保留'));
    await maybeGenerateTitle(sessionId, userId, visibleContent, assistantContent, modelCfg, user);
    return { assistantMessageResult, assistantMessageId };
}

module.exports = {
    persistAssistantTurn
};
