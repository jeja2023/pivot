/* 角色与规范库路由 Prompt Library Routes */
const express = require('express');
const { query, queryOne, execute } = require('../db/client');
const { asyncHandler } = require('../http');
const { getBeijingTimestamp } = require('../time');
const { isSuperAdmin } = require('../permissions');

const PROMPT_TYPES = new Set(['role', 'output', 'method', 'workflow']);
const PROMPT_TARGETS = new Set(['chat', 'agent', 'workflow']);

function normalizePromptType(value) {
    const type = String(value || 'role').trim();
    return PROMPT_TYPES.has(type) ? type : 'role';
}

function normalizePromptTargets(value) {
    let list = value;
    if (typeof value === 'string') {
        list = value.split(',');
    }
    if (!Array.isArray(list)) list = ['chat', 'agent', 'workflow'];
    const targets = [...new Set(list.map(item => String(item || '').trim()).filter(item => PROMPT_TARGETS.has(item)))];
    return targets.length ? targets : ['chat', 'agent', 'workflow'];
}

function normalizePromptPayload(body = {}, fallback = {}) {
    const name = String(body.name || '').trim().slice(0, 80);
    const content = String(body.content || '').trim().slice(0, 8000);
    const category = String(body.category || fallback.category || '通用').trim().slice(0, 40) || '通用';
    const description = String(body.description || fallback.description || '').trim().slice(0, 300);
    const type = normalizePromptType(body.type || fallback.type);
    const targetSurfaces = normalizePromptTargets(body.targetSurfaces ?? body.target_surfaces ?? fallback.target_surfaces);
    return {
        name,
        content,
        category,
        description,
        type,
        targetSurfaces,
        target_surfaces: targetSurfaces.join(',')
    };
}

function formatPrompt(row = {}) {
    const targetSurfaces = normalizePromptTargets(row.target_surfaces);
    return {
        ...row,
        description: row.description || '',
        type: normalizePromptType(row.type),
        target_surfaces: targetSurfaces.join(','),
        targetSurfaces
    };
}

function createPromptsRouter({
    authMiddleware,
    logAction
}) {
    const router = express.Router();

    router.get('/prompts', authMiddleware, asyncHandler(async (req, res) => {
        const prompts = await query(`
            SELECT * FROM prompts
            WHERE scope = 'global' OR user_id = ?
            ORDER BY CASE WHEN scope = 'global' THEN 0 ELSE 1 END, category, name
        `, [req.user.id]);
        const queryParams = req.query || {};
        const type = queryParams.type ? normalizePromptType(queryParams.type) : '';
        const surface = PROMPT_TARGETS.has(String(queryParams.surface || '').trim()) ? String(queryParams.surface || '').trim() : '';
        const keyword = String(queryParams.q || '').trim().toLowerCase();
        const filtered = prompts
            .map(formatPrompt)
            .filter(prompt => !type || prompt.type === type)
            .filter(prompt => !surface || prompt.targetSurfaces.includes(surface))
            .filter(prompt => !keyword || [prompt.name, prompt.category, prompt.description, prompt.content].some(value => String(value || '').toLowerCase().includes(keyword)));
        res.json(filtered);
    }));

    router.post('/prompts', authMiddleware, asyncHandler(async (req, res) => {
        const payload = normalizePromptPayload(req.body);
        const scope = isSuperAdmin(req.user) && req.body.scope === 'global' ? 'global' : 'personal';
        const userId = scope === 'global' ? null : req.user.id;
        if (!payload.name || !payload.content) return res.status(400).json({ error: '规范名称和内容不能为空' });

        const now = getBeijingTimestamp();
        const row = await queryOne(`
            INSERT INTO prompts (user_id, name, content, category, description, type, target_surfaces, scope, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
        `, [userId, payload.name, payload.content, payload.category, payload.description, payload.type, payload.target_surfaces, scope, now, now]);
        logAction(req, '创建角色与规范', `资产: ${payload.name}，范围: ${scope}`);
        res.json({ success: true, id: row?.id });
    }));

    router.put('/prompts/:id', authMiddleware, asyncHandler(async (req, res) => {
        const prompt = await queryOne('SELECT * FROM prompts WHERE id = ?', [req.params.id]);
        if (!prompt) return res.status(404).json({ error: '角色与规范不存在' });
        if (prompt.scope === 'global' && !isSuperAdmin(req.user)) return res.status(403).json({ error: '只有 admin 权限层级可以修改全局角色与规范' });
        if (prompt.scope !== 'global' && prompt.user_id !== req.user.id && !isSuperAdmin(req.user)) return res.status(403).json({ error: '无权修改该角色与规范' });

        const payload = normalizePromptPayload(req.body, prompt);
        const scope = isSuperAdmin(req.user) && req.body.scope === 'global' ? 'global' : (prompt.scope === 'global' ? 'global' : 'personal');
        const userId = scope === 'global' ? null : (prompt.user_id || req.user.id);
        if (!payload.name || !payload.content) return res.status(400).json({ error: '规范名称和内容不能为空' });

        await execute(`
            UPDATE prompts
            SET user_id = ?, name = ?, content = ?, category = ?, description = ?, type = ?, target_surfaces = ?, scope = ?, updated_at = ?
            WHERE id = ?
        `, [userId, payload.name, payload.content, payload.category, payload.description, payload.type, payload.target_surfaces, scope, getBeijingTimestamp(), req.params.id]);
        logAction(req, '修改角色与规范', `资产ID: ${req.params.id}，名称: ${payload.name}`);
        res.json({ success: true });
    }));

    router.delete('/prompts/:id', authMiddleware, asyncHandler(async (req, res) => {
        const prompt = await queryOne('SELECT * FROM prompts WHERE id = ?', [req.params.id]);
        if (!prompt) return res.status(404).json({ error: '角色与规范不存在' });
        if (prompt.scope === 'global' && !isSuperAdmin(req.user)) return res.status(403).json({ error: '只有 admin 权限层级可以删除全局角色与规范' });
        if (prompt.scope !== 'global' && prompt.user_id !== req.user.id && !isSuperAdmin(req.user)) return res.status(403).json({ error: '无权删除该角色与规范' });
        await execute('DELETE FROM prompts WHERE id = ?', [req.params.id]);
        logAction(req, '删除角色与规范', `资产ID: ${req.params.id}，名称: ${prompt.name}`);
        res.json({ success: true });
    }));

    return router;
}

module.exports = { createPromptsRouter };
