/* 会话管理路由 Session Management Routes */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { removeAttachmentFiles } = require('../security');
const { getBeijingTimestamp } = require('../time');

const normalizeTags = (value) => String(value || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(',');

function createSessionsRouter({
    authMiddleware,
    normalizePage,
    normalizeLimit,
    logAction
}) {
    const router = express.Router();

    router.get('/sessions', authMiddleware, (req, res) => {
        const page = normalizePage(req.query.page || 1);
        const limit = normalizeLimit(req.query.limit || 20);
        const keyword = String(req.query.keyword || '').trim();
        const tag = String(req.query.tag || '').trim();
        const archived = req.query.archived === 'true' ? 1 : 0;
        const offset = (page - 1) * limit;

        let query = `
            SELECT s.*,
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as msg_count
            FROM sessions s
            WHERE s.user_id = ? AND COALESCE(s.is_archived, 0) = ?
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

        query += ' ORDER BY s.is_pinned DESC, s.created_at DESC LIMIT ? OFFSET ? ';
        params.push(limit, offset);

        const sessions = db.prepare(query).all(...params);

        let countQuery = 'SELECT COUNT(*) as count FROM sessions s WHERE s.user_id = ? AND COALESCE(s.is_archived, 0) = ?';
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

        res.json({ data: sessions, total, hasMore: (offset + sessions.length) < total });
    });

    router.post('/sessions', authMiddleware, (req, res) => {
        const id = uuidv4();
        const title = req.body.title || '新对话';
        db.prepare('INSERT INTO sessions (id, user_id, title, created_at) VALUES (?, ?, ?, ?)')
          .run(id, req.user.id, title, getBeijingTimestamp());
        logAction(req, '创建对话', `创建对话: ${title}`);
        res.json({ id, title });
    });

    router.get('/sessions/tags/list', authMiddleware, (req, res) => {
        const rows = db.prepare("SELECT tags FROM sessions WHERE user_id = ? AND tags IS NOT NULL AND tags != ''").all(req.user.id);
        const tags = [...new Set(rows.flatMap(row => String(row.tags).split(',').map(tag => tag.trim()).filter(Boolean)))].sort();
        res.json(tags);
    });

    router.get('/sessions/:id', authMiddleware, (req, res) => {
        const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? AND user_id = ? ORDER BY created_at ASC').all(req.params.id, req.user.id);
        res.json(messages);
    });

    router.put('/sessions/:id', authMiddleware, (req, res) => {
        const { title } = req.body;
        const safeTitle = String(title || '').trim().slice(0, 80);
        const info = db.prepare('UPDATE sessions SET title = ? WHERE id = ? AND user_id = ?').run(safeTitle, req.params.id, req.user.id);
        if (info.changes > 0) logAction(req, '修改对话名称', `会话ID: ${req.params.id}，新名称: ${safeTitle}`);
        res.json({ success: info.changes > 0 });
    });

    router.put('/sessions/:id/pin', authMiddleware, (req, res) => {
        const { isPinned } = req.body;
        const stmt = db.prepare('UPDATE sessions SET is_pinned = ? WHERE id = ? AND user_id = ?');
        const info = stmt.run(isPinned ? 1 : 0, req.params.id, req.user.id);
        if (info.changes === 0) return res.status(404).json({ error: '会话不存在' });
        res.json({ success: true });
    });

    router.put('/sessions/:id/archive', authMiddleware, (req, res) => {
        const isArchived = req.body.isArchived ? 1 : 0;
        const info = db.prepare('UPDATE sessions SET is_archived = ? WHERE id = ? AND user_id = ?')
          .run(isArchived, req.params.id, req.user.id);
        if (info.changes === 0) return res.status(404).json({ error: '会话不存在' });
        logAction(req, isArchived ? '归档对话' : '恢复对话', `会话ID: ${req.params.id}`);
        res.json({ success: true });
    });

    router.put('/sessions/:id/tags', authMiddleware, (req, res) => {
        const tags = normalizeTags(req.body.tags);
        const info = db.prepare('UPDATE sessions SET tags = ? WHERE id = ? AND user_id = ?')
          .run(tags, req.params.id, req.user.id);
        if (info.changes === 0) return res.status(404).json({ error: '会话不存在' });
        logAction(req, '更新对话标签', `会话ID: ${req.params.id}，标签: ${tags || '-'}`);
        res.json({ success: true, tags });
    });

    router.put('/sessions/:id/system-prompt', authMiddleware, (req, res) => {
        const { systemPrompt } = req.body;
        const stmt = db.prepare('UPDATE sessions SET system_prompt = ? WHERE id = ? AND user_id = ?');
        const info = stmt.run(systemPrompt, req.params.id, req.user.id);
        if (info.changes === 0) return res.status(404).json({ error: '会话不存在' });
        res.json({ success: true });
    });

    router.delete('/messages/:id', authMiddleware, (req, res) => {
        const { id } = req.params;
        const info = db.prepare('DELETE FROM messages WHERE id = ? AND user_id = ?').run(id, req.user.id);
        if (info.changes > 0) logAction(req, '删除消息', `消息ID: ${id}`);
        res.json({ success: info.changes > 0 });
    });

    router.delete('/sessions/:id', authMiddleware, (req, res) => {
        const sessionId = req.params.id;
        const userId = req.user.id;
        const session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
        if (!session) return res.status(403).json({ error: '无权删除或会话不存在' });

        try {
            const deleteTx = db.transaction(() => {
                const attachments = db.prepare('SELECT file_path FROM attachments WHERE session_id = ? AND user_id = ?').all(sessionId, userId);
                db.prepare('DELETE FROM attachments WHERE session_id = ? AND user_id = ?').run(sessionId, userId);
                db.prepare('DELETE FROM messages WHERE session_id = ? AND user_id = ?').run(sessionId, userId);
                const info = db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(sessionId, userId);
                removeAttachmentFiles(attachments);
                return info;
            });

            const info = deleteTx();
            logAction(req, '删除对话', `删除会话ID: ${sessionId}`);
            res.json({ success: info.changes > 0 });
        } catch (e) {
            console.error('删除会话失败:', e);
            res.status(500).json({ error: '删除会话失败' });
        }
    });

    return router;
}

module.exports = { createSessionsRouter };
