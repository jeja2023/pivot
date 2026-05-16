/* 模型管理路由 Model Management Routes */
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { db } = require('../db');
const { asyncHandler } = require('../http');
const { assertSafeOutboundUrl, encryptSecret, validateModelUrl } = require('../security');
const {
    normalizeTags,
    normalizeBooleanFlag,
    getAccessibleModel,
    getUserRunnableModels
} = require('../services/models');
const { getEmbeddingConfig } = require('../services/rag-config');
const { getBeijingTimestamp } = require('../time');

const isSuperAdmin = (user) => user?.username === 'admin';

function buildModelsListUrl(url) {
    let modelsUrl = String(url || '').trim();
    if (!modelsUrl.includes('/v1') && !modelsUrl.includes('localhost') && !modelsUrl.includes('127.0.0.1')) {
        modelsUrl = modelsUrl.replace(/\/+$/, '') + '/v1';
    }
    if (!modelsUrl.endsWith('/models')) {
        modelsUrl = modelsUrl.replace(/\/+$/, '') + '/models';
    }
    return modelsUrl;
}

function createModelsRouter({ authMiddleware, logAction, normalizePage, normalizeLimit, probeLimiter = (req, res, next) => next() }) {
    const router = express.Router();

    router.get('/models/available', authMiddleware, asyncHandler(async (req, res) => {
        const models = getUserRunnableModels(req.user).map(model => ({
            id: model.id,
            user_id: model.user_id,
            name: model.name,
            model_name: model.model_name,
            daily_token_limit: model.daily_token_limit,
            allowed_units: model.allowed_units,
            supports_vision: model.supports_vision,
            supports_reasoning: model.supports_reasoning,
            type: 'chat',
            endpoint: '/v1/chat/completions',
            capabilities: [
                'chat',
                Number(model.supports_vision || 0) === 1 ? 'vision' : null,
                Number(model.supports_reasoning || 0) === 1 ? 'reasoning' : null
            ].filter(Boolean)
        }));

        const embeddingConfig = getEmbeddingConfig(req.user?.id);
        const embeddingModel = String(embeddingConfig.http?.model || '').trim();
        const embeddingUrl = String(embeddingConfig.http?.url || '').trim();
        if (embeddingModel && embeddingUrl && !models.some(model => model.model_name === embeddingModel && model.type === 'embedding')) {
            models.push({
                id: `embedding:${embeddingModel}`,
                name: `${embeddingModel} (向量模型)`,
                model_name: embeddingModel,
                type: 'embedding',
                endpoint: '/v1/embeddings',
                capabilities: ['embeddings'],
                source: embeddingConfig.source?.url === 'user' || embeddingConfig.source?.model === 'user' || embeddingConfig.source?.apiKey === 'user'
                    ? 'personal'
                    : 'system'
            });
        }

        res.json(models);
    }));

    router.post('/models/fetch-remote', authMiddleware, probeLimiter, asyncHandler(async (req, res) => {
        let { url, api_key, id } = req.body;
        if (!url) return res.status(400).json({ error: '请填写接口地址' });

        url = String(url || '').trim();
        if (api_key) api_key = String(api_key).trim();

        try {
            await assertSafeOutboundUrl(url, req.user);
        } catch (e) {
            logAction(req, '模型列表拉取拦截', e.message);
            return res.json({ success: false, error: e.message });
        }

        // 处理掩码情况：只能复用当前用户可访问模型且 URL 未被替换时的真实 Key
        if (id && api_key === '********') {
            const storedModel = getAccessibleModel(id, req.user);
            if (!storedModel || String(storedModel.id) !== String(id)) {
                logAction(req, '模型列表拉取拦截', `无权复用模型密钥，模型ID: ${id}`);
                return res.status(403).json({ success: false, error: '无权访问该模型或模型不存在' });
            }
            if (storedModel.secret_error) {
                return res.json({ success: false, error: `${storedModel.secret_error}，请重新保存该模型的 API Key` });
            }
            if (new URL(buildModelsListUrl(url)).href !== new URL(buildModelsListUrl(storedModel.url)).href) {
                logAction(req, '模型列表拉取拦截', `拒绝将模型密钥用于不同 URL，模型ID: ${id}`);
                return res.status(400).json({ success: false, error: '接口地址已变更，请重新输入 API Key 后再获取模型列表' });
            }
            api_key = storedModel.api_key;
        }

        // 尝试自动补全 /v1
        let modelsUrl = buildModelsListUrl(url);

        try {
            const response = await axios.get(modelsUrl, {
                headers: {
                    'Authorization': api_key ? `Bearer ${api_key}` : undefined,
                    'x-api-key': api_key || undefined,
                    'User-Agent': 'Pivot-AI-Client/1.0'
                },
                timeout: 10000,
                proxy: false
            });
            const rawModels = response.data.data || [];
            const modelIds = rawModels.map(m => m.id);
            res.json({ success: true, models: modelIds });
        } catch (e) {
            const errMsg = e.response?.data?.error?.message || e.message || '获取模型列表失败';
            res.json({ success: false, error: errMsg });
        }
    }));

    router.post('/models/test', authMiddleware, probeLimiter, asyncHandler(async (req, res) => {
        let { id, url, api_key, model_name, source } = req.body;
        const testId = crypto.randomUUID().slice(0, 8);
        const testSource = source || (id ? 'auto' : 'manual');

        if (id) {
            const storedModel = getAccessibleModel(id, req.user);
            if (!storedModel || String(storedModel.id) !== String(id)) {
                return res.status(403).json({ error: '无权测试该模型或模型不存在' });
            }
            if (storedModel.secret_error) {
                logAction(req, '模型测试拦截', `模型 ID: ${id}，原因: ${storedModel.secret_error}`);
                return res.json({ success: false, requestId: testId, error: `${storedModel.secret_error}，请重新保存该模型的 API Key` });
            }
            // 允许请求中的新值覆盖数据库值，除非请求值为掩码或空
            if (!url) url = storedModel.url;
            if (!api_key || api_key === '********') api_key = storedModel.api_key;
            if (!model_name) model_name = storedModel.model_name;
        }

        if (!url) return res.json({ success: false, requestId: testId, error: '请填写接口地址' });

        url = url.trim();
        if (api_key) api_key = api_key.trim();

        try {
            await assertSafeOutboundUrl(url, req.user);
        } catch (e) {
            logAction(req, '模型测试拦截', e.message);
            return res.json({ success: false, requestId: testId, error: e.message });
        }

        if (!url.includes('/v1') && !url.includes('localhost') && !url.includes('127.0.0.1')) {
            url = url.replace(/\/+$/, '') + '/v1';
        }

        let chatUrl = url;
        if (!chatUrl.endsWith('/chat/completions')) {
            chatUrl = chatUrl.replace(/\/+$/, '') + '/chat/completions';
        }

        const testLabel = `${model_name || '未命名'}${id ? `#${id}` : ''}`;
        req.log.debug({ testId, testSource, testLabel, chatUrl }, '正在验证模型地址');
        if (chatUrl.includes('localhost') || chatUrl.includes('127.0.0.1')) {
            req.log.debug({ testId }, '检测到 localhost，如果您是在 Docker 中运行，可能需要改为 host.docker.internal');
        }

        try {
            const testUrl = chatUrl.replace('/chat/completions', '/models');
            req.log.debug({ testId, testUrl }, '探测模型路径');
            await assertSafeOutboundUrl(testUrl, req.user);
            await axios.get(testUrl, {
                headers: {
                    'Authorization': api_key ? `Bearer ${api_key}` : undefined,
                    'x-api-key': api_key || undefined,
                    'User-Agent': 'Pivot-AI-Client/1.0'
                },
                timeout: 10000,
                proxy: false
            });
            req.log.info(`模型测试成功: ${testLabel} (ID: ${testId})`);
            logAction(req, '测试模型', `模型连接成功: ${model_name || url}`);
            res.json({ success: true, requestId: testId, message: '连接成功' });
        } catch (e) {
            const errMsg = e.response?.data?.error?.message || e.message || e.code || '未知连接错误';
            req.log.error({ testId, err: errMsg }, '模型连接失败');
            logAction(req, '测试模型失败', `模型: ${model_name || url}，原因: ${errMsg}`);
            res.json({ success: false, requestId: testId, error: errMsg });
        }
    }));

    router.get('/models', authMiddleware, asyncHandler(async (req, res) => {
        const page = normalizePage(req.query.page);
        const limit = normalizeLimit(req.query.limit);
        const offset = (page - 1) * limit;
        let where = '';
        let params = [];

        if (req.user.role !== 'admin') {
            where = "WHERE COALESCE(m.status, 'active') = 'active' AND (m.user_id = ? OR (m.user_id IS NULL AND (COALESCE(m.allowed_units, '') = '' OR instr(',' || m.allowed_units || ',', ?) > 0)))";
            params = [req.user.id, `,${(req.user.unit || '').trim()},`];
        } else {
            where = "WHERE COALESCE(m.status, 'active') = 'active'";
        }

        // 为管理员增加过滤：不显示普通用户的私有默认模型
        if (req.user.role === 'admin') {
            const adminFilter = isSuperAdmin(req.user)
                ? "(m.user_id IS NULL OR u.role = 'admin' OR m.is_default = 0)"
                : "(m.user_id IS NULL OR m.user_id = ?)";
            where = where ? `${where} AND ${adminFilter}` : `WHERE ${adminFilter}`;
            if (!isSuperAdmin(req.user)) params.push(req.user.id);
        }

        const sql = `
            SELECT 
                m.id, m.user_id, m.name, 
                (CASE 
                    WHEN ? = 1 AND (m.user_id IS NULL OR u.role = 'admin') THEN m.url
                    WHEN m.user_id = ? THEN m.url
                    ELSE '********'
                END) as url,
                m.model_name, m.is_default, 
                m.daily_token_limit, m.allowed_units, m.created_at,
                m.temperature, m.max_input_tokens, m.max_tokens, m.monitor_url, m.max_concurrent, m.supports_vision, m.supports_reasoning,
                (CASE WHEN m.api_key IS NOT NULL AND length(m.api_key) > 0 THEN '********' ELSE '' END) AS api_key,
                u.username as owner_name, u.nickname as owner_nickname, u.role as owner_role
            FROM models m
            LEFT JOIN users u ON m.user_id = u.id
            ${where} 
            ORDER BY m.is_default DESC, m.id ASC 
            LIMIT ? OFFSET ?
        `;
        const models = db.prepare(sql).all(isSuperAdmin(req.user) ? 1 : 0, req.user.id, ...params, limit, offset);
        const countSql = `
            SELECT COUNT(*) as count 
            FROM models m
            LEFT JOIN users u ON m.user_id = u.id
            ${where}
        `;
        const total = db.prepare(countSql).get(...params).count;
        res.json({ data: models, total });
    }));

    router.post('/models', authMiddleware, asyncHandler(async (req, res) => {
        const { name, url, api_key, model_name, temperature, max_input_tokens, max_tokens, monitor_url } = req.body;
        if (!name || !url) return res.status(400).json({ error: '模型名称和接口地址不能为空' });
        validateModelUrl(url, req.user);
        if (monitor_url) validateModelUrl(monitor_url, req.user);

        const targetUserId = req.user.role === 'admin' && isSuperAdmin(req.user) && req.body.scope === 'global'
            ? null
            : req.user.id;
        const dailyLimit = Math.max(parseInt(req.body.daily_token_limit, 10) || 0, 0);
        const allowedUnits = targetUserId === null ? normalizeTags(req.body.allowed_units) : '';
        
        const temp = temperature !== undefined && temperature !== '' ? parseFloat(temperature) : null;
        const maxInputTokens = max_input_tokens !== undefined && max_input_tokens !== '' ? parseInt(max_input_tokens, 10) : null;
        const maxTokens = max_tokens !== undefined && max_tokens !== '' ? parseInt(max_tokens, 10) : null;
        const maxConcurrent = Math.max(parseInt(req.body.max_concurrent, 10) || 0, 0);
        const supportsVision = normalizeBooleanFlag(req.body.supports_vision);
        const supportsReasoning = normalizeBooleanFlag(req.body.supports_reasoning);

        db.prepare('INSERT INTO models (user_id, name, url, api_key, model_name, daily_token_limit, allowed_units, created_at, temperature, max_input_tokens, max_tokens, monitor_url, max_concurrent, supports_vision, supports_reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(targetUserId, name, url, encryptSecret(api_key), model_name, dailyLimit, allowedUnits, getBeijingTimestamp(), temp, maxInputTokens, maxTokens, monitor_url || '', maxConcurrent, supportsVision, supportsReasoning);

        logAction(req, '添加模型', `添加${targetUserId === null ? '全局' : '个人'}模型: ${name}`);
        res.json({ success: true });
    }));

    router.put('/models/:id', authMiddleware, asyncHandler(async (req, res) => {
        const { name, url, api_key, model_name, temperature, max_input_tokens, max_tokens, monitor_url } = req.body;
        if (!name || !url) return res.status(400).json({ error: '模型名称和接口地址不能为空' });
        validateModelUrl(url, req.user);
        if (monitor_url) validateModelUrl(monitor_url, req.user);

        let existing;
        if (req.user.role === 'admin') {
            existing = isSuperAdmin(req.user)
                ? db.prepare(`
                    SELECT m.* FROM models m
                    LEFT JOIN users u ON m.user_id = u.id
                    WHERE m.id = ? AND (m.user_id IS NULL OR u.role = 'admin')
                `).get(req.params.id)
                : db.prepare('SELECT * FROM models WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
        } else {
            existing = db.prepare("SELECT * FROM models WHERE id = ? AND user_id = ?").get(req.params.id, req.user.id);
        }
        if (!existing) return res.status(403).json({ error: '无权操作或模型不存在' });

        const nextApiKey = (api_key === '********') ? existing.api_key : encryptSecret(api_key);
        const dailyLimit = Math.max(parseInt(req.body.daily_token_limit, 10) || 0, 0);
        const allowedUnits = req.user.role === 'admin' && isSuperAdmin(req.user) && existing.user_id === null
            ? normalizeTags(req.body.allowed_units)
            : (existing.allowed_units || '');
        
        const temp = temperature !== undefined && temperature !== '' ? parseFloat(temperature) : null;
        const maxInputTokens = max_input_tokens !== undefined && max_input_tokens !== '' ? parseInt(max_input_tokens, 10) : null;
        const maxTokens = max_tokens !== undefined && max_tokens !== '' ? parseInt(max_tokens, 10) : null;
        const maxConcurrent = Math.max(parseInt(req.body.max_concurrent, 10) || 0, 0);
        const supportsVision = normalizeBooleanFlag(req.body.supports_vision);
        const supportsReasoning = normalizeBooleanFlag(req.body.supports_reasoning);

        let info;
        if (req.user.role === 'admin' && isSuperAdmin(req.user) && existing.user_id === null) {
            info = db.prepare('UPDATE models SET name = ?, url = ?, api_key = ?, model_name = ?, daily_token_limit = ?, allowed_units = ?, temperature = ?, max_input_tokens = ?, max_tokens = ?, monitor_url = ?, max_concurrent = ?, supports_vision = ?, supports_reasoning = ? WHERE id = ?')
              .run(name, url, nextApiKey, model_name, dailyLimit, allowedUnits, temp, maxInputTokens, maxTokens, monitor_url || '', maxConcurrent, supportsVision, supportsReasoning, req.params.id);
        } else {
            info = db.prepare('UPDATE models SET name = ?, url = ?, api_key = ?, model_name = ?, daily_token_limit = ?, temperature = ?, max_input_tokens = ?, max_tokens = ?, monitor_url = ?, max_concurrent = ?, supports_vision = ?, supports_reasoning = ? WHERE id = ? AND user_id = ?')
              .run(name, url, nextApiKey, model_name, dailyLimit, temp, maxInputTokens, maxTokens, monitor_url || '', maxConcurrent, supportsVision, supportsReasoning, req.params.id, req.user.id);
        }

        if (info.changes > 0) {
            logAction(req, '修改模型', `更新模型: ${name} (ID: ${req.params.id})`);
            res.json({ success: true });
        } else {
            res.status(403).json({ error: '无权修改或模型不存在' });
        }
    }));

    router.delete('/models/:id', authMiddleware, asyncHandler(async (req, res) => {
        let info;
        if (req.user.role === 'admin' && isSuperAdmin(req.user)) {
            info = db.prepare('DELETE FROM models WHERE id = ?').run(req.params.id);
        } else {
            info = db.prepare('DELETE FROM models WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
        }
        if (info.changes > 0) {
            logAction(req, '删除模型', `删除模型ID: ${req.params.id}`);
            res.json({ success: true });
        } else {
            res.status(403).json({ error: '无权删除或模型不存在' });
        }
    }));

    router.post('/models/:id/key', authMiddleware, asyncHandler(async (req, res) => {
        const { password } = req.body;
        if (!password) return res.status(400).json({ error: '需要输入密码进行二次验证' });

        const bcrypt = require('bcryptjs');
        const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
        if (!bcrypt.compareSync(password, user.password_hash)) {
            logAction(req, '模型密钥查看失败', `密码验证失败，模型ID: ${req.params.id}`);
            return res.status(401).json({ error: '密码错误' });
        }

        const model = getAccessibleModel(req.params.id, req.user);
        if (!model) return res.status(403).json({ error: '无权查看或模型不存在' });
        if (model.user_id === null && !isSuperAdmin(req.user)) {
            logAction(req, '模型密钥查看拦截', `非超级管理员尝试查看全局模型密钥，模型ID: ${req.params.id}`);
            return res.status(403).json({ error: '无权查看全局模型密钥' });
        }
        if (model.user_id !== null && model.user_id !== req.user.id && !isSuperAdmin(req.user)) {
            return res.status(403).json({ error: '无权查看该模型密钥' });
        }
        logAction(req, '查看模型密钥', `模型ID: ${req.params.id}`);
        res.json({ key: model.api_key || '' });
    }));

    return router;
}

module.exports = { createModelsRouter };
