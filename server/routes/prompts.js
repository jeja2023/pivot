/* 提示词指令路由 Prompt Command Routes */
const express = require('express');
const { db } = require('../db');
const { asyncHandler } = require('../http');
const { getBeijingTimestamp } = require('../time');

function createPromptsRouter({
    authMiddleware,
    logAction
}) {
    const router = express.Router();

    router.get('/prompts', authMiddleware, asyncHandler(async (req, res) => {
        const prompts = db.prepare(`
            SELECT * FROM prompts
            WHERE scope = 'global' OR user_id = ?
            ORDER BY CASE WHEN scope = 'global' THEN 0 ELSE 1 END, category, name
        `).all(req.user.id);
        res.json(prompts);
    }));

    router.post('/prompts', authMiddleware, asyncHandler(async (req, res) => {
        const name = String(req.body.name || '').trim().slice(0, 80);
        const content = String(req.body.content || '').trim().slice(0, 8000);
        const category = String(req.body.category || '通用').trim().slice(0, 40) || '通用';
        const scope = req.user.role === 'admin' && req.body.scope === 'global' ? 'global' : 'personal';
        const userId = scope === 'global' ? null : req.user.id;
        if (!name || !content) return res.status(400).json({ error: '指令名称和内容不能为空' });

        const info = db.prepare('INSERT INTO prompts (user_id, name, content, category, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(userId, name, content, category, scope, getBeijingTimestamp());
        logAction(req, '创建指令模板', `模板: ${name}，范围: ${scope}`);
        res.json({ success: true, id: info.lastInsertRowid });
    }));

    router.put('/prompts/:id', authMiddleware, asyncHandler(async (req, res) => {
        const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);
        if (!prompt) return res.status(404).json({ error: '指令不存在' });
        if (prompt.scope === 'global' && req.user.role !== 'admin') return res.status(403).json({ error: '无权修改全局指令' });
        if (prompt.scope !== 'global' && prompt.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: '无权修改该指令' });

        const name = String(req.body.name || '').trim().slice(0, 80);
        const content = String(req.body.content || '').trim().slice(0, 8000);
        const category = String(req.body.category || '通用').trim().slice(0, 40) || '通用';
        const scope = req.user.role === 'admin' && req.body.scope === 'global' ? 'global' : prompt.scope;
        const userId = scope === 'global' ? null : (prompt.user_id || req.user.id);
        if (!name || !content) return res.status(400).json({ error: '指令名称和内容不能为空' });

        db.prepare('UPDATE prompts SET user_id = ?, name = ?, content = ?, category = ?, scope = ? WHERE id = ?')
          .run(userId, name, content, category, scope, req.params.id);
        logAction(req, '修改指令模板', `模板ID: ${req.params.id}，名称: ${name}`);
        res.json({ success: true });
    }));

    router.delete('/prompts/:id', authMiddleware, asyncHandler(async (req, res) => {
        const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);
        if (!prompt) return res.status(404).json({ error: '指令不存在' });
        if (prompt.scope === 'global' && req.user.role !== 'admin') return res.status(403).json({ error: '无权删除全局指令' });
        if (prompt.scope !== 'global' && prompt.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: '无权删除该指令' });
        db.prepare('DELETE FROM prompts WHERE id = ?').run(req.params.id);
        logAction(req, '删除指令模板', `模板ID: ${req.params.id}，名称: ${prompt.name}`);
        res.json({ success: true });
    }));

    return router;
}

module.exports = { createPromptsRouter };
