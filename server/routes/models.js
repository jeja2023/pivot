/* 模型管理路由 Model Management Routes */
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const db = require('../db');
const { asyncHandler } = require('../http');
const { encryptSecret, validateModelUrl } = require('../security');
const {
    modelListFields,
    normalizeTags,
    getAccessibleModel
} = require('../services/models');

function createModelsRouter({ authMiddleware, logAction, normalizePage, normalizeLimit }) {
    const router = express.Router();

    router.post('/models/test', authMiddleware, asyncHandler(async (req, res) => {
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
            validateModelUrl(url, req.user);
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
        console.log(`\n[模型测试:${testId}] [${testSource}] [${testLabel}] 正在验证地址: ${chatUrl}`);
        if (chatUrl.includes('localhost') || chatUrl.includes('127.0.0.1')) {
            console.log(`[模型测试:${testId}] [提示] 检测到 localhost，如果您是在 Docker 中运行，可能需要改为 host.docker.internal`);
        }

        try {
            const testUrl = chatUrl.replace('/chat/completions', '/models');
            console.log(`[模型测试:${testId}] [探测路径] ${testUrl}`);
            const response = await axios.get(testUrl, {
                headers: {
                    'Authorization': api_key ? `Bearer ${api_key}` : undefined,
                    'x-api-key': api_key || undefined,
                    'User-Agent': 'Pivot-AI-Client/1.0'
                },
                timeout: 10000,
                proxy: false
            });
            console.log(`[模型测试:${testId}] [${testSource}] [${testLabel}] 连接成功 (HTTP ${response.status})`);
            logAction(req, '测试模型', `模型连接成功: ${model_name || url}`);
            res.json({ success: true, requestId: testId, message: '连接成功' });
        } catch (e) {
            const errMsg = e.response?.data?.error?.message || e.message || e.code || '未知连接错误';
            console.error(`[模型测试:${testId}] [${testSource}] [${testLabel}] 连接失败: ${errMsg}`);
            logAction(req, '测试模型失败', `模型: ${model_name || url}，原因: ${errMsg}`);
            res.json({ success: false, requestId: testId, error: errMsg });
        }
    }));

    router.get('/models', authMiddleware, (req, res) => {
        const page = normalizePage(req.query.page);
        const limit = normalizeLimit(req.query.limit);
        const offset = (page - 1) * limit;
        let where = '';
        let params = [];

        if (req.user.role !== 'admin') {
            where = "WHERE (user_id = ? OR (user_id IS NULL AND (COALESCE(allowed_units, '') = '' OR instr(',' || allowed_units || ',', ?) > 0)))";
            params = [req.user.id, `,${(req.user.unit || '').trim()},`];
        }

        try {
            const sql = `SELECT ${modelListFields} FROM models ${where} ORDER BY is_default DESC, id ASC LIMIT ? OFFSET ?`;
            const models = db.prepare(sql).all(...params, limit, offset);
            const countSql = `SELECT COUNT(*) as count FROM models ${where}`;
            const total = db.prepare(countSql).get(...params).count;
            res.json({ data: models, total });
        } catch (e) {
            console.error(`[模型查询失败] 用户: ${req.user.username}, 角色: ${req.user.role}, 错误: ${e.message}`);
            console.error(`[失败 SQL] SELECT ${modelListFields} FROM models ${where}`);
            res.status(500).json({ error: '获取模型列表失败: ' + e.message });
        }
    });

    router.post('/models', authMiddleware, (req, res) => {
        const { name, url, api_key, model_name } = req.body;
        if (!name || !url) return res.status(400).json({ error: '模型名称和接口地址不能为空' });
        try {
            validateModelUrl(url, req.user);
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }

        const targetUserId = req.user.role === 'admin' ? null : req.user.id;
        const dailyLimit = Math.max(parseInt(req.body.daily_token_limit, 10) || 0, 0);
        const allowedUnits = req.user.role === 'admin' ? normalizeTags(req.body.allowed_units) : '';

        db.prepare('INSERT INTO models (user_id, name, url, api_key, model_name, daily_token_limit, allowed_units) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(targetUserId, name, url, encryptSecret(api_key), model_name, dailyLimit, allowedUnits);

        logAction(req, '添加模型', `添加${targetUserId === null ? '全局' : '个人'}模型: ${name}`);
        res.json({ success: true });
    });

    router.put('/models/:id', authMiddleware, (req, res) => {
        const { name, url, api_key, model_name } = req.body;
        if (!name || !url) return res.status(400).json({ error: '模型名称和接口地址不能为空' });
        try {
            validateModelUrl(url, req.user);
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }

        const existing = db.prepare("SELECT * FROM models WHERE id = ? AND (? = 'admin' OR user_id = ?)").get(req.params.id, req.user.role, req.user.id);
        if (!existing) return res.status(403).json({ error: '无权修改或模型不存在' });

        const nextApiKey = (api_key === '********') ? existing.api_key : encryptSecret(api_key);
        const dailyLimit = Math.max(parseInt(req.body.daily_token_limit, 10) || 0, 0);
        const allowedUnits = req.user.role === 'admin' ? normalizeTags(req.body.allowed_units) : (existing.allowed_units || '');
        let info;
        if (req.user.role === 'admin') {
            info = db.prepare('UPDATE models SET name = ?, url = ?, api_key = ?, model_name = ?, daily_token_limit = ?, allowed_units = ? WHERE id = ?')
              .run(name, url, nextApiKey, model_name, dailyLimit, allowedUnits, req.params.id);
        } else {
            info = db.prepare('UPDATE models SET name = ?, url = ?, api_key = ?, model_name = ?, daily_token_limit = ? WHERE id = ? AND user_id = ?')
              .run(name, url, nextApiKey, model_name, dailyLimit, req.params.id, req.user.id);
        }

        if (info.changes > 0) {
            logAction(req, '修改模型', `更新模型: ${name} (ID: ${req.params.id})`);
            res.json({ success: true });
        } else {
            res.status(403).json({ error: '无权修改或模型不存在' });
        }
    });

    router.delete('/models/:id', authMiddleware, (req, res) => {
        let info;
        if (req.user.role === 'admin') {
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
    });

    router.get('/models/:id/key', authMiddleware, (req, res) => {
        const model = getAccessibleModel(req.params.id, req.user);
        if (!model) return res.status(403).json({ error: '无权查看或模型不存在' });
        if (model.user_id === null && req.user.role !== 'admin') {
            logAction(req, '模型密钥查看拦截', `普通用户尝试查看全局模型密钥，模型ID: ${req.params.id}`);
            return res.status(403).json({ error: '无权查看全局模型密钥' });
        }
        if (model.user_id !== null && model.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: '无权查看该模型密钥' });
        }
        logAction(req, '查看模型密钥', `模型ID: ${req.params.id}`);
        res.json({ key: model.api_key || '' });
    });

    return router;
}

module.exports = { createModelsRouter };
