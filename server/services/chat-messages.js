const { estimateTokens } = require('../llm');
const { getBeijingTimestamp } = require('../time');
const sessionsRepository = require('../repositories/sessions');

async function insertMessage({ sessionId, userId, role, content, tokenCount, modelId, agentRunId = null, createdAt }) {
    const finalTokenCount = Number.isFinite(Number(tokenCount)) ? Number(tokenCount) : estimateTokens(content);
    const finalCreatedAt = createdAt || getBeijingTimestamp();
    return await sessionsRepository.insertMessage({
        sessionId,
        userId,
        role,
        content,
        tokenCount: finalTokenCount,
        modelId,
        agentRunId,
        createdAt: finalCreatedAt
    });
}

async function saveUserMessage({ sessionId, userId, content, modelId }) {
    return await insertMessage({
        sessionId,
        userId,
        role: 'user',
        content,
        modelId
    });
}

async function saveAssistantMessage({ sessionId, userId, content, modelId, tokenCount, agentRunId = null }) {
    return await insertMessage({
        sessionId,
        userId,
        role: 'assistant',
        content,
        modelId,
        tokenCount,
        agentRunId
    });
}

async function touchSession(sessionId, timestamp = getBeijingTimestamp()) {
    return await sessionsRepository.touchSession(sessionId, timestamp);
}

async function updateLastAssistantStats({ sessionId, userId, costTime, tps }) {
    const lastMsg = await sessionsRepository.getLastAssistantMessage(sessionId, userId);

    if (!lastMsg) return false;
    await sessionsRepository.updateMessageStats(lastMsg.id, costTime, tps);
    return true;
}

async function updateAssistantStats({ messageId, costTime, tps }) {
    const id = Number(messageId);
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    await sessionsRepository.updateMessageStats(id, costTime, tps);
    return true;
}

async function countVisibleConversationMessages(sessionId, userId) {
    return await sessionsRepository.countVisibleConversationMessages(sessionId, userId);
}

module.exports = {
    countVisibleConversationMessages,
    insertMessage,
    saveAssistantMessage,
    saveUserMessage,
    touchSession,
    updateAssistantStats,
    updateLastAssistantStats
};
