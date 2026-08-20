const { saveAssistantMessage, updateLastAssistantStats } = require('./chat-messages');
const { maybeGenerateTitle } = require('./chat-title');
const { scheduleMemoryExtraction } = require('./long-term-memory');

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
    tps = null
}) {
    const assistantMessageResult = await saveAssistantMessage({
        sessionId,
        userId,
        content: assistantContent,
        tokenCount: assistantTokens,
        modelId: modelCfg.id
    });
    const assistantMessageId = Number(assistantMessageResult?.lastInsertRowid || 0) || null;
    if (costTime !== null || tps !== null) {
        await updateLastAssistantStats({ sessionId, userId, costTime, tps });
    }
    await scheduleMemoryExtraction({
        userId,
        sessionId,
        messageIds: [userMessageId, assistantMessageId].filter(Boolean),
        user,
        modelCfg
    });
    await maybeGenerateTitle(sessionId, userId, visibleContent, assistantContent, modelCfg, user);
    return { assistantMessageResult, assistantMessageId };
}

module.exports = {
    persistAssistantTurn
};