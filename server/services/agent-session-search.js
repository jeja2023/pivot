'use strict';

const { query } = require('../db/client');
const { parsePositiveInt } = require('../number');

function parseIsoTime(value, label) {
    if (!value) return null;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) throw new Error(`${label}必须是 ISO 8601 时间。`);
    return date.toISOString();
}

// 历史会话始终由 user_id 约束，来源链接只含会话 ID，前端仍须通过现有 Session ACL 打开。
async function searchUserSessions(user, input = {}) {
    const searchQuery = String(input.query || '').trim();
    if (!searchQuery) throw new Error('请填写检索关键词。');
    const like = `%${searchQuery}%`;
    const limit = parsePositiveInt(input.limit, 8, 20);
    const sessionId = String(input.sessionId || input.session_id || '').trim().slice(0, 128);
    const from = parseIsoTime(input.from, 'from');
    const to = parseIsoTime(input.to, 'to');
    if (from && to && from > to) throw new Error('from 不能晚于 to。');
    const filters = ['m.user_id = ?', 'm.deleted_at IS NULL', 's.deleted_at IS NULL', 'm.content LIKE ?'];
    const params = [user.id, like];
    if (sessionId) { filters.push('m.session_id = ?'); params.push(sessionId); }
    if (from) { filters.push('m.created_at >= ?'); params.push(from); }
    if (to) { filters.push('m.created_at <= ?'); params.push(to); }
    params.push(limit);
    const rows = await query(`
        SELECT m.id, m.session_id, s.title, m.role, substring(m.content from 1 for 1200) AS content, m.created_at
        FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE ${filters.join(' AND ')}
        ORDER BY m.created_at DESC LIMIT ?
    `, params);
    return rows.map(row => ({
        id: row.id, sessionId: row.session_id, sessionTitle: row.title || '未命名会话', role: row.role,
        content: row.content, createdAt: row.created_at,
        source: { sessionId: row.session_id, messageId: row.id, title: row.title || '未命名会话', createdAt: row.created_at },
        openUrl: `/chat?sessionId=${encodeURIComponent(row.session_id)}`
    }));
}

module.exports = { searchUserSessions };
