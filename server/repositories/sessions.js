/**
 * server/repositories/sessions.js
 * 会话与消息数据访问层（SQLite / PostgreSQL 双方言）
 *
 * 全部接口返回 Promise：PG 驱动本质异步，无法在 Node 中同步等待。
 * SQLite 模式下 client.js 会把同步结果包装为已 resolve 的 Promise，
 * 因此调用方统一 await 即可，无需感知方言。
 */
const { query, queryOne, execute } = require('../db/client');

function getSessionById(sessionId, userId) {
    return queryOne(`
        SELECT *
        FROM sessions
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `, [sessionId, userId]);
}

function listMessages(sessionId, userId) {
    return query(`
        SELECT m.*, COALESCE(md.name, md.model_name, '') AS model_name, md.model_name AS model_api_name
        FROM messages m
        LEFT JOIN models md ON md.id = m.model_id
        WHERE m.session_id = ? AND m.user_id = ? AND m.deleted_at IS NULL
        ORDER BY m.id ASC
    `, [sessionId, userId]);
}

async function listMessagePage(sessionId, userId, { beforeId = null, limit = 60 } = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 60, 1), 100);
    const normalizedBeforeId = Number.parseInt(beforeId, 10);
    const hasBeforeId = Number.isSafeInteger(normalizedBeforeId) && normalizedBeforeId > 0;
    const rows = await query(`
        SELECT m.*, COALESCE(md.name, md.model_name, '') AS model_name, md.model_name AS model_api_name
        FROM messages m
        LEFT JOIN models md ON md.id = m.model_id
        WHERE m.session_id = ?
          AND m.user_id = ?
          AND m.deleted_at IS NULL
          AND m.role IN ('user', 'assistant')
          ${hasBeforeId ? 'AND m.id < ?' : ''}
        ORDER BY m.id DESC
        LIMIT ?
    `, [sessionId, userId, ...(hasBeforeId ? [normalizedBeforeId] : []), safeLimit + 1]);
    const hasMore = rows.length > safeLimit;
    const messages = rows.slice(0, safeLimit).reverse();
    return {
        messages,
        page: {
            hasMore,
            beforeId: messages.length ? Number(messages[0].id) : null,
            limit: safeLimit
        }
    };
}

function listAttachmentTokens(userId, sessionId, now) {
    return query(`
        SELECT file_path, access_token
        FROM attachments
        WHERE user_id = ? AND session_id = ? AND access_token IS NOT NULL AND access_token != ''
          AND deleted_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
    `, [userId, sessionId, now]);
}

function createSession({ id, userId, title, createdAt }) {
    return execute(
        'INSERT INTO sessions (id, user_id, title, created_at) VALUES (?, ?, ?, ?)',
        [id, userId, title, createdAt]
    );
}

function getSessionIdForUser(sessionId, userId) {
    return queryOne(
        'SELECT id FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
        [sessionId, userId]
    );
}

function listSessionTagValues(userId) {
    return query(
        "SELECT tags FROM sessions WHERE user_id = ? AND deleted_at IS NULL AND tags IS NOT NULL AND tags != ''",
        [userId]
    );
}

function getSessionTitle(sessionId, userId) {
    return queryOne(
        'SELECT title FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
        [sessionId, userId]
    );
}

function updateSessionTitle(sessionId, userId, title) {
    return execute(
        'UPDATE sessions SET title = ? WHERE id = ? AND user_id = ?',
        [title, sessionId, userId]
    );
}

async function insertMessage({ sessionId, userId, role, content, tokenCount, modelId, agentRunId = null, createdAt }) {
    const row = await queryOne(`
        INSERT INTO messages (session_id, user_id, role, content, token_count, model_id, agent_run_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
    `, [sessionId, userId, role, content, tokenCount, modelId || null, agentRunId || null, createdAt]);
    return { changes: 1, lastInsertRowid: row ? row.id : null };
}

function touchSession(sessionId, timestamp) {
    return execute('UPDATE sessions SET updated_at = ? WHERE id = ?', [timestamp, sessionId]);
}

function getLastAssistantMessage(sessionId, userId) {
    return queryOne(`
        SELECT id FROM messages
        WHERE session_id = ? AND user_id = ? AND role = 'assistant' AND deleted_at IS NULL
        ORDER BY id DESC LIMIT 1
    `, [sessionId, userId]);
}

function updateMessageStats(messageId, costTime, tokensPerSec) {
    return execute(
        'UPDATE messages SET cost_time = ?, tokens_per_sec = ? WHERE id = ?',
        [costTime, tokensPerSec, messageId]
    );
}

async function countVisibleConversationMessages(sessionId, userId) {
    const row = await queryOne(`
        SELECT COUNT(*) AS count
        FROM messages
        WHERE session_id = ? AND user_id = ? AND role IN ('user', 'assistant') AND deleted_at IS NULL
    `, [sessionId, userId]);
    return Number(row?.count || 0);
}

module.exports = {
    getSessionById,
    listMessages,
    listMessagePage,
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
