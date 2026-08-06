const { sql } = require('../db/statements');

function getSessionById(sessionId, userId) {
    return sql(`
        SELECT *
        FROM sessions
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).get(sessionId, userId);
}

function listMessages(sessionId, userId) {
    return sql(`
        SELECT m.*, COALESCE(md.name, md.model_name, '') AS model_name, md.model_name AS model_api_name
        FROM messages m
        LEFT JOIN models md ON md.id = m.model_id
        WHERE m.session_id = ? AND m.user_id = ? AND m.deleted_at IS NULL
        ORDER BY m.id ASC
    `).all(sessionId, userId);
}

function listAttachmentTokens(userId, sessionId, now) {
    return sql(`
        SELECT file_path, access_token
        FROM attachments
        WHERE user_id = ? AND session_id = ? AND access_token IS NOT NULL AND access_token != ''
          AND deleted_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
    `).all(userId, sessionId, now);
}

function createSession({ id, userId, title, createdAt }) {
    return sql('INSERT INTO sessions (id, user_id, title, created_at) VALUES (?, ?, ?, ?)')
        .run(id, userId, title, createdAt);
}

function getSessionIdForUser(sessionId, userId) {
    return sql('SELECT id FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
        .get(sessionId, userId);
}

function listSessionTagValues(userId) {
    return sql("SELECT tags FROM sessions WHERE user_id = ? AND deleted_at IS NULL AND tags IS NOT NULL AND tags != ''")
        .all(userId);
}

function getSessionTitle(sessionId, userId) {
    return sql('SELECT title FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
        .get(sessionId, userId);
}

function updateSessionTitle(sessionId, userId, title) {
    return sql('UPDATE sessions SET title = ? WHERE id = ? AND user_id = ?')
        .run(title, sessionId, userId);
}

function insertMessage({ sessionId, userId, role, content, tokenCount, modelId, createdAt }) {
    return sql(`
        INSERT INTO messages (session_id, user_id, role, content, token_count, model_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, userId, role, content, tokenCount, modelId || null, createdAt);
}

function touchSession(sessionId, timestamp) {
    return sql('UPDATE sessions SET updated_at = ? WHERE id = ?').run(timestamp, sessionId);
}

function getLastAssistantMessage(sessionId, userId) {
    return sql(`
        SELECT id FROM messages
        WHERE session_id = ? AND user_id = ? AND role = 'assistant' AND deleted_at IS NULL
        ORDER BY id DESC LIMIT 1
    `).get(sessionId, userId);
}

function updateMessageStats(messageId, costTime, tokensPerSec) {
    return sql('UPDATE messages SET cost_time = ?, tokens_per_sec = ? WHERE id = ?')
        .run(costTime, tokensPerSec, messageId);
}

function countVisibleConversationMessages(sessionId, userId) {
    return sql(`
        SELECT COUNT(*) AS count
        FROM messages
        WHERE session_id = ? AND user_id = ? AND role IN ('user', 'assistant') AND deleted_at IS NULL
    `).get(sessionId, userId).count;
}

module.exports = {
    getSessionById,
    listMessages,
    listAttachmentTokens,
    createSession,
    getSessionIdForUser,
    listSessionTagValues,
    getSessionTitle,
    updateSessionTitle,
    insertMessage,
    touchSession,
    getLastAssistantMessage,
    updateMessageStats,
    countVisibleConversationMessages
};
