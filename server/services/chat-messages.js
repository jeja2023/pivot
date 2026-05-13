const { db } = require('../db');
const { estimateTokens } = require('../llm');
const { getBeijingTimestamp } = require('../time');

function insertMessage({ sessionId, userId, role, content, tokenCount, modelId, createdAt }) {
    const finalTokenCount = Number.isFinite(Number(tokenCount)) ? Number(tokenCount) : estimateTokens(content);
    const finalCreatedAt = createdAt || getBeijingTimestamp();
    return db.prepare(`
        INSERT INTO messages (session_id, user_id, role, content, token_count, model_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, userId, role, content, finalTokenCount, modelId || null, finalCreatedAt);
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
    return db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(timestamp, sessionId);
}

function updateLastAssistantStats({ sessionId, userId, costTime, tps }) {
    const lastMsg = db.prepare(`
        SELECT id FROM messages
        WHERE session_id = ? AND user_id = ? AND role = 'assistant' AND deleted_at IS NULL
        ORDER BY id DESC LIMIT 1
    `).get(sessionId, userId);

    if (!lastMsg) return false;
    db.prepare('UPDATE messages SET cost_time = ?, tokens_per_sec = ? WHERE id = ?')
      .run(costTime, tps, lastMsg.id);
    return true;
}

function countVisibleConversationMessages(sessionId, userId) {
    return db.prepare(`
        SELECT COUNT(*) as count
        FROM messages
        WHERE session_id = ? AND user_id = ? AND role IN ('user', 'assistant') AND deleted_at IS NULL
    `).get(sessionId, userId).count;
}

module.exports = {
    countVisibleConversationMessages,
    insertMessage,
    saveAssistantMessage,
    saveUserMessage,
    touchSession,
    updateLastAssistantStats
};
