/* 会话管理路由 Session Management Routes */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, stmts } = require('../db');
const { asyncHandler } = require('../http');
const { getBeijingTimestamp } = require('../time');
const { buildFtsQuery } = require('../search');
const { buildContextMeta } = require('../llm');

const normalizeTags = (value) => String(value || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(',');

const SESSION_SORT_EXPR = 'COALESCE(s.updated_at, s.created_at)';
const SESSION_SORT_DATE_EXPR = `date(${SESSION_SORT_EXPR})`;

function encodeSessionCursor(row) {
    if (!row) return null;
    const payload = {
        day: row.sort_day || '',
        pinned: Number(row.is_pinned || 0),
        time: row.sort_time || row.updated_at || row.created_at || '',
        id: row.id || ''
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeSessionCursor(value) {
    if (!value) return null;
    try {
        const cursor = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
        if (!cursor || !cursor.day || !cursor.time || !cursor.id) return null;
        return {
            day: String(cursor.day),
            pinned: Number(cursor.pinned || 0),
            time: String(cursor.time),
            id: String(cursor.id)
        };
    } catch (e) {
        return null;
    }
}

function appendAttachmentTokens(messages, userId, sessionId) {
    const rows = db.prepare(`
        SELECT file_path, access_token
        FROM attachments
        WHERE user_id = ? AND session_id = ? AND access_token IS NOT NULL AND access_token != ''
    `).all(userId, sessionId);
    if (rows.length === 0) return messages;

    const tokenByUrl = new Map(rows.map(row => [
        '/' + String(row.file_path || '').replace(/\\/g, '/'),
        row.access_token
    ]));

    return messages.map(message => {
        let content = String(message.content || '');
        for (const [url, token] of tokenByUrl.entries()) {
            const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            content = content.replace(new RegExp(`${escapedUrl}(?![\\w/?=&%.-])`, 'g'), `${url}?token=${token}`);
        }
        return { ...message, content };
    });
}

function createSessionsRouter({
    authMiddleware,
    normalizePage,
    normalizeLimit,
    logAction
}) {
    const router = express.Router();

    router.get('/sessions', authMiddleware, asyncHandler(async (req, res) => {
        const page = normalizePage(req.query.page || 1);
        const limit = normalizeLimit(req.query.limit || 20);
        const keyword = String(req.query.keyword || '').trim();
        const tag = String(req.query.tag || '').trim();
        const archived = req.query.archived === 'true' ? 1 : 0;
        const cursor = decodeSessionCursor(req.query.cursor);
        const offset = (page - 1) * limit;

        let query = `
            SELECT s.*,
            ${SESSION_SORT_DATE_EXPR} AS sort_day,
            ${SESSION_SORT_EXPR} AS sort_time,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.deleted_at IS NULL) as msg_count
            FROM sessions s
            WHERE s.user_id = ? AND COALESCE(s.is_archived, 0) = ? AND s.deleted_at IS NULL
        `;
        let params = [req.user.id, archived];

        if (keyword) {
            query += ` AND s.title LIKE ? `;
            params.push(`%${keyword}%`);
        }
        if (tag) {
            query += ` AND (',' || COALESCE(s.tags, '') || ',') LIKE ? `;
            params.push(`%,${tag},%`);
        }
        if (cursor) {
            query += ` AND (
                ${SESSION_SORT_DATE_EXPR} < ?
                OR (${SESSION_SORT_DATE_EXPR} = ? AND COALESCE(s.is_pinned, 0) < ?)
                OR (${SESSION_SORT_DATE_EXPR} = ? AND COALESCE(s.is_pinned, 0) = ? AND ${SESSION_SORT_EXPR} < ?)
                OR (${SESSION_SORT_DATE_EXPR} = ? AND COALESCE(s.is_pinned, 0) = ? AND ${SESSION_SORT_EXPR} = ? AND s.id < ?)
            ) `;
            params.push(
                cursor.day,
                cursor.day, cursor.pinned,
                cursor.day, cursor.pinned, cursor.time,
                cursor.day, cursor.pinned, cursor.time, cursor.id
            );
        }

        query += ` ORDER BY
            ${SESSION_SORT_DATE_EXPR} DESC,
            COALESCE(s.is_pinned, 0) DESC,
            ${SESSION_SORT_EXPR} DESC,
            s.id DESC
            LIMIT ? `;
        params.push(limit + 1);
        if (!cursor && page > 1) {
            query += ` OFFSET ? `;
            params.push(offset);
        }

        const rows = db.prepare(query).all(...params);
        const sessions = rows.slice(0, limit);
        const hasMore = rows.length > limit;
        const nextCursor = hasMore ? encodeSessionCursor(sessions[sessions.length - 1]) : null;

        let countQuery = 'SELECT COUNT(*) as count FROM sessions s WHERE s.user_id = ? AND COALESCE(s.is_archived, 0) = ? AND s.deleted_at IS NULL';
        let countParams = [req.user.id, archived];
        if (keyword) {
            countQuery += ` AND s.title LIKE ?`;
            countParams.push(`%${keyword}%`);
        }
        if (tag) {
            countQuery += ` AND (',' || COALESCE(s.tags, '') || ',') LIKE ?`;
            countParams.push(`%,${tag},%`);
        }
        const total = db.prepare(countQuery).get(...countParams).count;

        res.json({
            data: sessions,
            total,
            hasMore: cursor || page === 1 ? hasMore : (offset + sessions.length) < total,
            nextCursor
        });
    }));

    router.post('/sessions', authMiddleware, asyncHandler(async (req, res) => {
        const id = uuidv4();
        const title = req.body.title || '新对话';
        db.prepare('INSERT INTO sessions (id, user_id, title, created_at) VALUES (?, ?, ?, ?)')
          .run(id, req.user.id, title, getBeijingTimestamp());
        logAction(req, '创建对话', `创建对话: ${title}`);
        res.json({ id, title });
    }));

    router.get('/sessions/tags/list', authMiddleware, asyncHandler(async (req, res) => {
        const rows = db.prepare("SELECT tags FROM sessions WHERE user_id = ? AND deleted_at IS NULL AND tags IS NOT NULL AND tags != ''").all(req.user.id);
        const tags = [...new Set(rows.flatMap(row => String(row.tags).split(',').map(tag => tag.trim()).filter(Boolean)))].sort();
        res.json(tags);
    }));

    router.get('/sessions/search/content', authMiddleware, asyncHandler(async (req, res) => {
        const keyword = String(req.query.keyword || '').trim();
        if (!keyword) return res.json({ data: [] });
        const ftsQuery = buildFtsQuery(keyword);
        if (!ftsQuery) return res.json({ data: [] });

        const sessions = db.prepare(`
            SELECT DISTINCT s.*, 
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.deleted_at IS NULL) as msg_count,
            snippet(messages_fts, 0, '<b>', '</b>', '...', 20) as snippet
            FROM sessions s
            JOIN messages m ON m.session_id = s.id
            JOIN messages_fts f ON f.rowid = m.id
            WHERE s.user_id = ? AND s.deleted_at IS NULL AND m.deleted_at IS NULL AND messages_fts MATCH ?
            ORDER BY s.updated_at DESC
            LIMIT 50
        `).all(req.user.id, ftsQuery);

        res.json({ data: sessions });
    }));

    router.get('/sessions/:id', authMiddleware, asyncHandler(async (req, res) => {
        const session = stmts.getSessionById.get(req.params.id, req.user.id);
        if (!session) return res.status(404).json({ error: '会话不存在' });
        const rawMessages = stmts.getMessages.all(req.params.id, req.user.id);
        const messages = appendAttachmentTokens(rawMessages, req.user.id, req.params.id);
        res.json({ session, messages, contextMeta: buildContextMeta(rawMessages) });
    }));

    router.get('/sessions/:id/export', authMiddleware, asyncHandler(async (req, res) => {
        const session = stmts.getSessionById.get(req.params.id, req.user.id);
        if (!session) return res.status(404).json({ error: '会话不存在' });
        const messages = stmts.getMessages.all(req.params.id, req.user.id);
        
        let content = `# ${session.title}\n\n`;
        content += `> 导出时间: ${getBeijingTimestamp()}\n\n`;
        
        for (const msg of messages) {
            const role = msg.role === 'user' ? '👤 用户' : '🤖 助手';
            content += `### ${role}\n\n${msg.content}\n\n---\n\n`;
        }

        res.setHeader('Content-disposition', `attachment; filename="chat_${req.params.id.slice(0, 8)}.md"`);
        res.setHeader('Content-type', 'text/markdown; charset=utf-8');
        res.send(content);
    }));

    router.put('/sessions/:id', authMiddleware, asyncHandler(async (req, res) => {
        const { title } = req.body;
        const safeTitle = String(title || '').trim().slice(0, 80);
        const info = stmts.updateSessionTitle.run(safeTitle, getBeijingTimestamp(), req.params.id, req.user.id);
        if (info.changes > 0) logAction(req, '修改对话名称', `会话ID: ${req.params.id}，新名称: ${safeTitle}`);
        res.json({ success: info.changes > 0 });
    }));

    router.put('/sessions/:id/pin', authMiddleware, asyncHandler(async (req, res) => {
        const { isPinned } = req.body;
        const stmt = db.prepare('UPDATE sessions SET is_pinned = ? WHERE id = ? AND user_id = ?');
        const info = stmt.run(isPinned ? 1 : 0, req.params.id, req.user.id);
        if (info.changes === 0) return res.status(404).json({ error: '会话不存在' });
        res.json({ success: true });
    }));

    router.put('/sessions/:id/archive', authMiddleware, asyncHandler(async (req, res) => {
        const isArchived = req.body.isArchived ? 1 : 0;
        const info = db.prepare('UPDATE sessions SET is_archived = ? WHERE id = ? AND user_id = ?')
          .run(isArchived, req.params.id, req.user.id);
        if (info.changes === 0) return res.status(404).json({ error: '会话不存在' });
        logAction(req, isArchived ? '归档对话' : '恢复对话', `会话ID: ${req.params.id}`);
        res.json({ success: true });
    }));

    router.put('/sessions/:id/tags', authMiddleware, asyncHandler(async (req, res) => {
        const tags = normalizeTags(req.body.tags);
        const info = db.prepare('UPDATE sessions SET tags = ? WHERE id = ? AND user_id = ?')
          .run(tags, req.params.id, req.user.id);
        if (info.changes === 0) return res.status(404).json({ error: '会话不存在' });
        logAction(req, '更新对话标签', `会话ID: ${req.params.id}，标签: ${tags || '-'}`);
        res.json({ success: true, tags });
    }));

    router.put('/sessions/:id/system-prompt', authMiddleware, asyncHandler(async (req, res) => {
        const { systemPrompt } = req.body;
        const stmt = db.prepare('UPDATE sessions SET system_prompt = ? WHERE id = ? AND user_id = ?');
        const info = stmt.run(systemPrompt, req.params.id, req.user.id);
        if (info.changes === 0) return res.status(404).json({ error: '会话不存在' });
        res.json({ success: true });
    }));

    router.delete('/messages/:id', authMiddleware, asyncHandler(async (req, res) => {
        const { id } = req.params;
        const info = db.prepare('UPDATE messages SET deleted_at = ?, deleted_by_user = 1 WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
            .run(getBeijingTimestamp(), id, req.user.id);
        if (info.changes > 0) logAction(req, '删除消息', `消息ID: ${id}`);
        res.json({ success: info.changes > 0 });
    }));

    router.delete('/sessions/:id', authMiddleware, asyncHandler(async (req, res) => {
        const sessionId = req.params.id;
        const userId = req.user.id;
        const session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(sessionId, userId);
        if (!session) return res.status(403).json({ error: '无权删除或会话不存在' });

        const deleteTx = db.transaction(() => {
            const now = getBeijingTimestamp();
            db.prepare('UPDATE attachments SET deleted_at = ?, deleted_by_user = 1 WHERE session_id = ? AND user_id = ? AND deleted_at IS NULL').run(now, sessionId, userId);
            db.prepare('UPDATE messages SET deleted_at = ?, deleted_by_user = 1 WHERE session_id = ? AND user_id = ? AND deleted_at IS NULL').run(now, sessionId, userId);
            const info = db.prepare('UPDATE sessions SET deleted_at = ?, deleted_by_user = 1, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL').run(now, now, sessionId, userId);
            return info;
        });

        const info = deleteTx();
        logAction(req, '删除对话', `删除会话ID: ${sessionId}`);
        res.json({ success: info.changes > 0 });
    }));

    return router;
}

module.exports = { createSessionsRouter };
