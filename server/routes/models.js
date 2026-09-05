/* 模型管理路由 */
const express = require('express');
const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { asyncHandler } = require('../http');
const {
    assertSafeOutboundUrl,
    encryptSecret,
    decryptSecret,
    validateModelUrl
} = require('../security');
const {
    normalizeTags,
    normalizeBooleanFlag,
    normalizeToolCallMode,
    validateModelTokenSettings,
    normalizePriceCurrency,
    normalizePriceValue,
    isChatThinkingEnabled,
    getAccessibleModelAsync,
    getUserRunnableModelsAsync
} = require('../services/models');
const { getEmbeddingConfig } = require('../services/rag-config');
const { getBeijingTimestamp } = require('../time');
const { isAdmin, isSuperAdmin } = require('../permissions');
const { safeJsonGet } = require('../services/safe-http-client');

async function clearModelDefaultReferences(modelId) {
    const id = String(modelId || '').trim();
    if (!id) return;
    await execute("UPDATE app_settings SET value = '', updated_at = ? WHERE key = 'default_model_id' AND value = ?",
        [getBeijingTimestamp(), id]);
    await execute('UPDATE users SET default_model_id = NULL WHERE default_model_id = ?', [Number(id) || id]);
}

function canManageModel(model, user) {
    if (!model || !user) return false;
    if (model.user_id === user.id) return true;
    return model.user_id === null && isSuperAdmin(user);
}

function canUseStoredModelSecret(model, user) {
    return canManageModel(model, user);
}

function canTestModel(model, user) {
    if (!model || !user) return false;
    if (model.user_id === user.id) return true;
    return model.user_id === null && isAdmin(user);
}

function normalizeChatThinkingEnabledFlag(body = {}) {
    return normalizeBooleanFlag(body.chat_thinking_enabled);
}

async function getTestableModel(modelId, user) {
    if (!modelId || !user?.id) return null;
    const isNumeric = /^\d+$/.test(String(modelId));
    const canTestGlobal = isAdmin(user) ? 1 : 0;
    let model;
    if (isNumeric) {
        model = await queryOne(
            "SELECT * FROM models WHERE COALESCE(status, 'active') = 'active' AND (id = ? OR model_name = ?) AND (user_id = ? OR (user_id IS NULL AND ? = 1))",
            [modelId, modelId, user.id, canTestGlobal]
        );
    } else {
        model = await queryOne(
            "SELECT * FROM models WHERE COALESCE(status, 'active') = 'active' AND model_name = ? AND (user_id = ? OR (user_id IS NULL AND ? = 1))",
            [modelId, user.id, canTestGlobal]
        );
    }
    if (!model) return null;
    if (model.user_id && model.user_id !== user.id) return null;
    if (!model.user_id && !isAdmin(user) && model.allowed_units) {
        const units = String(model.allowed_units || '').split(',').map(unit => unit.trim()).filter(Boolean);
        const userUnit = String(user.unit || '').trim();
        if (!userUnit || !units.includes(userUnit)) return null;
    }
    if (model.api_key) {
        try {
            model.api_key = decryptSecret(model.api_key);
        } catch (e) {
            model.api_key = '';
            model.secret_error = e.message || '模型密钥解密失败';
        }
    }
    return model;
}

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
        const models = (await getUserRunnableModelsAsync(req.user)).map(model => ({
            id: model.id,
            user_id: model.user_id,
            name: model.name,
            model_name: model.model_name,
            daily_token_limit: model.daily_token_limit,
            allowed_units: model.allowed_units,
            supports_vision: model.supports_vision,
            supports_reasoning: model.supports_reasoning,
            chat_thinking_enabled: isChatThinkingEnabled(model) ? 1 : 0,
            supports_tool_calls: model.supports_tool_calls,
            tool_call_mode: normalizeToolCallMode(model.tool_call_mode),
            tool_call_probe_status: model.tool_call_probe_status || 'unknown',
            input_price_per_million: model.input_price_per_million || 0,
            output_price_per_million: model.output_price_per_million || 0,
            price_currency: normalizePriceCurrency(model.price_currency),
            type: 'chat',
            endpoint: '/v1/chat/completions',
            capabilities: [
                'chat',
                Number(model.supports_vision || 0) === 1 ? 'vision' : null,
                Number(model.supports_reasoning || 0) === 1 ? 'reasoning' : null,
                normalizeToolCallMode(model.tool_call_mode) !== 'disabled'
                    && (Number(model.supports_tool_calls || 0) === 1 || normalizeToolCallMode(model.tool_call_mode) === 'enabled')
                    ? 'tool_calls'
                    : null
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
            const storedModel = await getAccessibleModelAsync(id, req.user);
            if (!storedModel || String(storedModel.id) !== String(id) || !canUseStoredModelSecret(storedModel, req.user)) {
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
            const response = await safeJsonGet(modelsUrl, {
                user: req.user,
                headers: {
                    'Authorization': api_key ? `Bearer ${api_key}` : undefined,
                    'x-api-key': api_key || undefined,
                    'User-Agent': 'Pivot-AI-Client/1.0'
                },
                timeout: 10000
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
            const storedModel = await getTestableModel(id, req.user);
            if (!storedModel || String(storedModel.id) !== String(id) || !canTestModel(storedModel, req.user)) {
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
            await safeJsonGet(testUrl, {
                user: req.user,
                headers: {
                    'Authorization': api_key ? `Bearer ${api_key}` : undefined,
                    'x-api-key': api_key || undefined,
                    'User-Agent': 'Pivot-AI-Client/1.0'
                },
                timeout: 10000
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
        let filterParams = [];

        if (!isAdmin(req.user)) {
            const unitCheck = "(COALESCE(m.allowed_units, '') = '' OR (',' || COALESCE(m.allowed_units, '') || ',') LIKE ('%,' || ? || ',%'))";
            where = `WHERE COALESCE(m.status, 'active') = 'active' AND (m.user_id = ? OR (m.user_id IS NULL AND ${unitCheck}))`;
            filterParams = [req.user.id, (req.user.unit || '').trim()];
        } else {
            where = "WHERE COALESCE(m.status, 'active') = 'active'";
        }

        // 为管理员增加过滤：不显示普通用户的私有默认模型
        if (isAdmin(req.user)) {
            const isDefaultZeroCond = 'COALESCE(m.is_default, 0) = 0';
            const adminFilter = isSuperAdmin(req.user)
                ? `(m.user_id IS NULL OR u.role = 'admin' OR ${isDefaultZeroCond})`
                : "(m.user_id IS NULL OR m.user_id = ?)";
            where = where ? `${where} AND ${adminFilter}` : `WHERE ${adminFilter}`;
            if (!isSuperAdmin(req.user)) filterParams.push(req.user.id);
        }

        const isSA = isSuperAdmin(req.user) ? 1 : 0;
        const sortDefaultExpr = 'COALESCE(m.is_default, 0)';
        const sql = `
            SELECT 
                m.id, m.user_id, m.name, 
                (CASE 
                    WHEN ? = 1 AND m.user_id IS NULL THEN m.url
                    WHEN m.user_id = ? THEN m.url
                    ELSE '********'
                END) as url,
                m.model_name, m.is_default, 
                m.daily_token_limit, m.allowed_units, m.created_at,
                m.temperature, m.max_input_tokens, m.max_tokens, m.context_window_tokens, m.monitor_url, m.max_concurrent, m.supports_vision, m.supports_reasoning, m.chat_thinking_enabled, m.supports_tool_calls, m.tool_call_mode, m.tool_call_probe_status, m.tool_call_probe_protocol, m.tool_call_probe_error, m.tool_call_probed_at,
                m.input_price_per_million, m.output_price_per_million, m.price_currency,
                (CASE WHEN m.api_key IS NOT NULL AND length(m.api_key) > 0 THEN '********' ELSE '' END) AS api_key,
                COALESCE(NULLIF(u.deleted_username, ''), u.username) as owner_name, u.nickname as owner_nickname, u.role as owner_role
            FROM models m
            LEFT JOIN users u ON m.user_id = u.id
            ${where} 
            ORDER BY ${sortDefaultExpr} DESC, m.id ASC 
            LIMIT ? OFFSET ?
        `;
        const models = (await query(sql, [isSA, req.user.id, ...filterParams, limit, offset]))
            .map(model => ({
                ...model,
                price_currency: normalizePriceCurrency(model.price_currency)
            }));
        const countSql = `
            SELECT COUNT(*) as count 
            FROM models m
            LEFT JOIN users u ON m.user_id = u.id
            ${where}
        `;
        const countRow = await queryOne(countSql, filterParams);
        const total = Number(countRow?.count || 0);
        res.json({ data: models, total });
    }));

    router.post('/models', authMiddleware, asyncHandler(async (req, res) => {
        const { name, url, api_key, model_name, temperature, max_input_tokens, max_tokens, context_window_tokens, monitor_url } = req.body;
        if (!name || !url) return res.status(400).json({ error: '模型名称和接口地址不能为空' });
        validateModelUrl(url, req.user);
        if (monitor_url) validateModelUrl(monitor_url, req.user);

        const targetUserId = isSuperAdmin(req.user) && req.body.scope === 'global'
            ? null
            : req.user.id;
        const dailyLimit = Math.max(parseInt(req.body.daily_token_limit, 10) || 0, 0);
        const allowedUnits = targetUserId === null ? normalizeTags(req.body.allowed_units) : '';

        const temp = temperature !== undefined && temperature !== '' ? parseFloat(temperature) : null;
        const tokenSettings = validateModelTokenSettings({ max_input_tokens, max_tokens, context_window_tokens });
        if (tokenSettings.error) return res.status(400).json({ error: tokenSettings.error });
        const { maxInputTokens, maxTokens, contextWindowTokens } = tokenSettings.values;
        const maxConcurrent = Math.max(parseInt(req.body.max_concurrent, 10) || 0, 0);
        const supportsVision = normalizeBooleanFlag(req.body.supports_vision);
        const supportsReasoning = normalizeBooleanFlag(req.body.supports_reasoning);
        const chatThinkingEnabled = normalizeChatThinkingEnabledFlag(req.body);
        const toolCallMode = normalizeToolCallMode(req.body.tool_call_mode);
        const inputPricePerMillion = normalizePriceValue(req.body.input_price_per_million);
        const outputPricePerMillion = normalizePriceValue(req.body.output_price_per_million);
        const priceCurrency = normalizePriceCurrency(req.body.price_currency);

        await execute(
            'INSERT INTO models (user_id, name, url, api_key, model_name, daily_token_limit, allowed_units, created_at, temperature, max_input_tokens, max_tokens, context_window_tokens, monitor_url, max_concurrent, supports_vision, supports_reasoning, chat_thinking_enabled, supports_tool_calls, tool_call_mode, input_price_per_million, output_price_per_million, price_currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [targetUserId, name, url, encryptSecret(api_key), model_name, dailyLimit, allowedUnits, getBeijingTimestamp(), temp, maxInputTokens, maxTokens, contextWindowTokens, monitor_url || '', maxConcurrent, supportsVision, supportsReasoning, chatThinkingEnabled, 0, toolCallMode, inputPricePerMillion, outputPricePerMillion, priceCurrency]
        );

        logAction(req, '添加模型', `添加${targetUserId === null ? '全局' : '个人'}模型: ${name}`);
        res.json({ success: true });
    }));

    router.put('/models/:id', authMiddleware, asyncHandler(async (req, res) => {
        const { name, url, api_key, model_name, temperature, max_input_tokens, max_tokens, context_window_tokens, monitor_url } = req.body;
        if (!name || !url) return res.status(400).json({ error: '模型名称和接口地址不能为空' });
        validateModelUrl(url, req.user);
        if (monitor_url) validateModelUrl(monitor_url, req.user);

        const existing = await queryOne('SELECT * FROM models WHERE id = ?', [req.params.id]);
        if (!canManageModel(existing, req.user)) return res.status(403).json({ error: '无权操作或模型不存在' });

        const nextApiKey = (api_key === '********') ? existing.api_key : encryptSecret(api_key);
        const dailyLimit = Math.max(parseInt(req.body.daily_token_limit, 10) || 0, 0);
        const allowedUnits = isSuperAdmin(req.user) && existing.user_id === null
            ? normalizeTags(req.body.allowed_units)
            : (existing.allowed_units || '');

        const temp = temperature !== undefined && temperature !== '' ? parseFloat(temperature) : null;
        const tokenSettings = validateModelTokenSettings({ max_input_tokens, max_tokens, context_window_tokens });
        if (tokenSettings.error) return res.status(400).json({ error: tokenSettings.error });
        const { maxInputTokens, maxTokens, contextWindowTokens } = tokenSettings.values;
        const maxConcurrent = Math.max(parseInt(req.body.max_concurrent, 10) || 0, 0);
        const supportsVision = normalizeBooleanFlag(req.body.supports_vision);
        const supportsReasoning = normalizeBooleanFlag(req.body.supports_reasoning);
        const chatThinkingEnabled = normalizeChatThinkingEnabledFlag(req.body);
        const toolCallMode = normalizeToolCallMode(req.body.tool_call_mode ?? existing.tool_call_mode);
        const inputPricePerMillion = normalizePriceValue(req.body.input_price_per_million);
        const outputPricePerMillion = normalizePriceValue(req.body.output_price_per_million);
        const priceCurrency = normalizePriceCurrency(req.body.price_currency || existing.price_currency);

        let changed;
        if (isSuperAdmin(req.user) && existing.user_id === null) {
            changed = await execute(
                'UPDATE models SET name = ?, url = ?, api_key = ?, model_name = ?, daily_token_limit = ?, allowed_units = ?, temperature = ?, max_input_tokens = ?, max_tokens = ?, context_window_tokens = ?, monitor_url = ?, max_concurrent = ?, supports_vision = ?, supports_reasoning = ?, chat_thinking_enabled = ?, tool_call_mode = ?, tool_call_probe_status = CASE WHEN tool_call_mode = ? THEN tool_call_probe_status ELSE \'unknown\' END, tool_call_probe_error = CASE WHEN tool_call_mode = ? THEN tool_call_probe_error ELSE \'\' END, input_price_per_million = ?, output_price_per_million = ?, price_currency = ? WHERE id = ?',
                [name, url, nextApiKey, model_name, dailyLimit, allowedUnits, temp, maxInputTokens, maxTokens, contextWindowTokens, monitor_url || '', maxConcurrent, supportsVision, supportsReasoning, chatThinkingEnabled, toolCallMode, toolCallMode, toolCallMode, inputPricePerMillion, outputPricePerMillion, priceCurrency, req.params.id]
            );
        } else {
            changed = await execute(
                'UPDATE models SET name = ?, url = ?, api_key = ?, model_name = ?, daily_token_limit = ?, temperature = ?, max_input_tokens = ?, max_tokens = ?, context_window_tokens = ?, monitor_url = ?, max_concurrent = ?, supports_vision = ?, supports_reasoning = ?, chat_thinking_enabled = ?, tool_call_mode = ?, tool_call_probe_status = CASE WHEN tool_call_mode = ? THEN tool_call_probe_status ELSE \'unknown\' END, tool_call_probe_error = CASE WHEN tool_call_mode = ? THEN tool_call_probe_error ELSE \'\' END, input_price_per_million = ?, output_price_per_million = ?, price_currency = ? WHERE id = ? AND user_id = ?',
                [name, url, nextApiKey, model_name, dailyLimit, temp, maxInputTokens, maxTokens, contextWindowTokens, monitor_url || '', maxConcurrent, supportsVision, supportsReasoning, chatThinkingEnabled, toolCallMode, toolCallMode, toolCallMode, inputPricePerMillion, outputPricePerMillion, priceCurrency, req.params.id, req.user.id]
            );
        }

        if (changed > 0) {
            logAction(req, '修改模型', `更新模型: ${name} (ID: ${req.params.id})`);
            res.json({ success: true });
        } else {
            res.status(403).json({ error: '无权修改或模型不存在' });
        }
    }));

    router.delete('/models/:id', authMiddleware, asyncHandler(async (req, res) => {
        const existing = await queryOne('SELECT * FROM models WHERE id = ?', [req.params.id]);
        if (!canManageModel(existing, req.user)) {
            return res.status(403).json({ error: '无权删除或模型不存在' });
        }
        let changed;
        if (isSuperAdmin(req.user) && existing.user_id === null) {
            changed = await execute("UPDATE models SET status = 'deleted', is_default = 0 WHERE id = ?", [req.params.id]);
        } else {
            changed = await execute("UPDATE models SET status = 'deleted', is_default = 0 WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
        }
        if (changed > 0) {
            await clearModelDefaultReferences(req.params.id);
            logAction(req, '删除模型', `删除模型ID: ${req.params.id}`);
            res.json({ success: true });
        } else {
            res.status(403).json({ error: '无权删除或模型不存在' });
        }
    }));

    router.post('/models/:id/key', authMiddleware, asyncHandler(async (req, res) => {
        const { password } = req.body;
        if (!password) return res.status(400).json({ error: '需要输入密码进行二次验证' });

        const model = await getAccessibleModelAsync(req.params.id, req.user);
        if (!canUseStoredModelSecret(model, req.user)) return res.status(403).json({ error: '无权查看该模型密钥' });

        const bcrypt = require('bcryptjs');
        const user = await queryOne('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
        if (!bcrypt.compareSync(password, user.password_hash)) {
            logAction(req, '模型密钥查看失败', `密码验证失败，模型ID: ${req.params.id}`);
            return res.status(401).json({ error: '密码错误' });
        }

        logAction(req, '查看模型密钥', `模型ID: ${req.params.id}`);
        res.json({ key: model.api_key || '' });
    }));

    return router;
}

module.exports = { createModelsRouter };
