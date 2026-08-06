const { estimateTokens } = require('../llm');
const { getBeijingTimestamp } = require('../time');
const sessionsRepository = require('../repositories/sessions');

function insertMessage({ sessionId, userId, role, content, tokenCount, modelId, createdAt }) {
    const finalTokenCount = Number.isFinite(Number(tokenCount)) ? Number(tokenCount) : estimateTokens(content);
    const finalCreatedAt = createdAt || getBeijingTimestamp();
    return sessionsRepository.insertMessage({
        sessionId,
        userId,
        role,
        content,
        tokenCount: finalTokenCount,
        modelId,
        createdAt: finalCreatedAt
    });
}

function saveUserMessage({ sessionId, userId, content, modelId }) {
    return insertMessage({
        sessionId,
        userId,
        role: 'user',
        content,
        modelId
    });
}

function saveAssistantMessage({ sessionId, userId, content, modelId, tokenCount }) {
    return insertMessage({
        sessionId,
        userId,
        role: 'assistant',
        content,
        modelId,
        tokenCount
    });
}

function touchSession(sessionId, timestamp = getBeijingTimestamp()) {
    return sessionsRepository.touchSession(sessionId, timestamp);
}

function updateLastAssistantStats({ sessionId, userId, costTime, tps }) {
    const lastMsg = sessionsRepository.getLastAssistantMessage(sessionId, userId);

    if (!lastMsg) return false;
    sessionsRepository.updateMessageStats(lastMsg.id, costTime, tps);
    return true;
}

function countVisibleConversationMessages(sessionId, userId) {
    return sessionsRepository.countVisibleConversationMessages(sessionId, userId);
}

module.exports = {
    countVisibleConversationMessages,
    insertMessage,
    saveAssistantMessage,
    saveUserMessage,
    touchSession,
    updateLastAssistantStats
};
