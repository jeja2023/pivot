/* 系统设置路由 System Settings Routes */
const express = require('express');
const axios = require('axios');
const { db, stmts } = require('../db');
const { asyncHandler } = require('../http');
const { getBeijingTimestamp } = require('../time');
const { clearAllRagCache } = require('../services/rag-cache');
const { assertSafeOutboundUrl, createSafeHttpAgentsForUser } = require('../security');
const {
    RAG_CONFIG_KEYS,
    getPublicEmbeddingConfig,
    getEmbeddingConfig,
    getRagConfig,
    toRagSettingValue
} = require('../services/rag-config');
const {
    MEMORY_CONFIG_KEYS,
    getMemoryConfig,
    toMemorySettingValue
} = require('../services/memory-config');
const {
    API_ACCESS_SETTING_KEY,
    getApiAccessSetting
} = require('../services/api-access-settings');
const {
    buildRuntimeConfigSnapshot,
    saveRuntimeConfig
} = require('../services/runtime-settings');
const { syncGlobalAiConcurrencySettings } = require('../services/concurrency');
const { getModelEndpointRuntimeStatus } = require('../services/model-runtime');
const { syncAgentRuntimeConcurrency } = require('../services/agent-runtime');
const { syncKnowledgeDocumentIndexConcurrency } = require('../services/rag-documents');
const { syncMemoryCompressionConcurrency } = require('../llm');
const { isSuperAdmin } = require('../permissions');

const allowedSettings = new Set([
    'default_model_id',
    API_ACCESS_SETTING_KEY,
    MEMORY_CONFIG_KEYS.threshold,
    RAG_CONFIG_KEYS.scoreThreshold,
    RAG_CONFIG_KEYS.topK,
    RAG_CONFIG_KEYS.candidateLimit,
    RAG_CONFIG_KEYS.chunkSize,
    RAG_CONFIG_KEYS.chunkOverlap,
    RAG_CONFIG_KEYS.embeddingMode,
    RAG_CONFIG_KEYS.embeddingApiUrl,
    RAG_CONFIG_KEYS.embeddingApiKey,
    RAG_CONFIG_KEYS.embeddingModel
]);

const userEmbeddingSettings = new Set([
    RAG_CONFIG_KEYS.scoreThreshold,
    RAG_CONFIG_KEYS.topK,
    RAG_CONFIG_KEYS.candidateLimit,
    RAG_CONFIG_KEYS.chunkSize,
    RAG_CONFIG_KEYS.chunkOverlap,
    RAG_CONFIG_KEYS.embeddingMode,
    RAG_CONFIG_KEYS.embeddingApiUrl,
    RAG_CONFIG_KEYS.embeddingApiKey,
    RAG_CONFIG_KEYS.embeddingModel
]);

function buildEmbeddingModelListUrls(url) {
    const rawUrl = String(url || '').trim().replace(/\/+$/, '');
    const lowerUrl = rawUrl.toLowerCase();
    if (!rawUrl) return [];
    if (lowerUrl.endsWith('/api/embed') || lowerUrl.endsWith('/api/embeddings')) {
        return [`${rawUrl.replace(/\/api\/(?:embed|embeddings)$/i, '')}/api/tags`];
    }
    if (lowerUrl.endsWith('/api/tags')) {
        return [rawUrl];
    }
    if (lowerUrl.endsWith('/models')) {
        return [rawUrl];
    }
    if (lowerUrl.endsWith('/v1')) {
        return [`${rawUrl}/models`];
    }
    return [`${rawUrl}/v1/models`, `${rawUrl}/models`, `${rawUrl}/api/tags`];
}

function extractEmbeddingModelIds(data) {
    const rawModels = Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.models) ? data.models
        : [];
    return rawModels
        .map(model => typeof model === 'string' ? model : (model?.id || model?.name || model?.model))
        .filter(Boolean);
}

const toSettingValue = (key, value) => {
    if (value === null || value === undefined || value === '') {
        return '';
    }
    if (Object.values(RAG_CONFIG_KEYS).includes(key)) {
        return toRagSettingValue(key, value);
    }
    if (Object.values(MEMORY_CONFIG_KEYS).includes(key)) {
        return toMemorySettingValue(key, value);
    }
    if (key === API_ACCESS_SETTING_KEY) {
        return value === true || String(value || '').trim().toLowerCase() === 'true' ? 'true' : 'false';
    }
    return String(value);
};

function getSettings() {
    const rows = db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings').all();
    const settings = {};
    rows.forEach(row => {
        settings[row.key] = {
            value: row.value,
            enabled: row.value === 'true',
            updatedAt: row.updated_at,
            updatedBy: row.updated_by
        };
    });
    return settings;
}

async function saveUserEmbeddingSettings(req, updates) {
    const stmt = db.prepare(`
        INSERT INTO user_settings (user_id, key, value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
    `);
    const removeStmt = db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?');
    const changed = [];

    for (const key of Object.keys(updates || {})) {
        if (!userEmbeddingSettings.has(key)) continue;
        const value = toSettingValue(key, updates[key]);
        if (key === RAG_CONFIG_KEYS.embeddingApiUrl && value) {
            await assertSafeOutboundUrl(value, req.user);
        }
        if (key === RAG_CONFIG_KEYS.embeddingApiKey && !value) continue;
        if (key !== RAG_CONFIG_KEYS.embeddingApiKey && !value) {
            removeStmt.run(req.user.id, key);
            changed.push(`${key}=<fallback>`);
            return;
        }
        stmt.run(req.user.id, key, value, getBeijingTimestamp());
        changed.push(key === RAG_CONFIG_KEYS.embeddingApiKey ? `${key}=********` : `${key}=${value}`);
    }

    return changed;
}

function createSettingsRouter({ authMiddleware, adminMiddleware, logAction }) {
    const router = express.Router();

    router.get('/settings', authMiddleware, (req, res) => {
        const settings = getSettings();
        res.json({
            ragEnabled: true,
            ragConfig: getRagConfig({}, isSuperAdmin(req.user) ? null : req.user?.id),
            memoryConfig: getMemoryConfig(settings),
            runtimeConfig: buildRuntimeConfigSnapshot(),
            apiAccessEnabled: getApiAccessSetting(),
            embeddingConfig: getPublicEmbeddingConfig(isSuperAdmin(req.user) ? null : req.user?.id),
            defaultModelId: settings.default_model_id?.value || null,
            personalDefaultModelId: req.user?.default_model_id || null,
            settings
        });
    });

    router.post('/settings/embedding-models', authMiddleware, asyncHandler(async (req, res) => {
        let { apiUrl, apiKey } = req.body || {};
        if (!apiUrl) return res.status(400).json({ success: false, error: '请先填写 Embedding Base URL' });

        apiUrl = String(apiUrl || '').trim();
        apiKey = String(apiKey || '').trim();
        
        // 如果用户没填密钥（输入框为空），尝试使用已保存的密钥
        if (!apiKey) {
            const savedConfig = getEmbeddingConfig(req.user.id).http;
            apiKey = savedConfig.apiKey || '';
        }
        try {
            await assertSafeOutboundUrl(apiUrl, req.user);
        } catch (e) {
            logAction(req, '向量模型列表拉取拦截', e.message);
            return res.json({ success: false, error: e.message });
        }

        const candidates = buildEmbeddingModelListUrls(apiUrl);
        let lastError = null;
        for (const modelsUrl of candidates) {
            try {
                await assertSafeOutboundUrl(modelsUrl, req.user);
                const agents = createSafeHttpAgentsForUser(req.user);
                const response = await axios.get(modelsUrl, {
                    headers: {
                        Authorization: apiKey ? `Bearer ${apiKey}` : undefined,
                        'x-api-key': apiKey || undefined,
                        'User-Agent': 'Pivot-AI-Client/1.0'
                    },
                    timeout: 10000,
                    proxy: false,
                    ...agents
                });
                const models = extractEmbeddingModelIds(response.data);
                if (models.length === 0) {
                    lastError = new Error('未获取到可用模型');
                    continue;
                }
                return res.json({ success: true, models: [...new Set(models)] });
            } catch (e) {
                lastError = e;
            }
        }

        const errMsg = lastError?.response?.data?.error?.message || lastError?.message || '获取模型列表失败';
        res.json({ success: false, error: errMsg });
    }));

    router.put('/settings/embedding', authMiddleware, asyncHandler(async (req, res) => {
        const changed = await saveUserEmbeddingSettings(req, req.body || {});
        if (changed.length > 0) {
            clearAllRagCache();
            logAction(req, '修改个人向量模型配置', changed.join('；'));
        }
        res.json({
            success: true,
            ragConfig: getRagConfig({}, req.user?.id),
            embeddingConfig: getPublicEmbeddingConfig(req.user?.id)
        });
    }));

    router.put('/settings/default-model', authMiddleware, asyncHandler(async (req, res) => {
        const rawModelId = req.body?.default_model_id;
        const parsedModelId = rawModelId === null || rawModelId === undefined || rawModelId === ''
            ? null
            : Number.parseInt(rawModelId, 10);

        if (parsedModelId !== null && (!Number.isInteger(parsedModelId) || parsedModelId <= 0)) {
            return res.status(400).json({ error: '默认模型参数无效' });
        }

        if (parsedModelId !== null) {
            const sql = isSuperAdmin(req.user)
                ? 'SELECT id FROM models WHERE id = ?'
                : 'SELECT id FROM models WHERE id = ? AND (user_id = ? OR user_id IS NULL)';
            const model = isSuperAdmin(req.user)
                ? db.prepare(sql).get(parsedModelId)
                : db.prepare(sql).get(parsedModelId, req.user.id);
            if (!model) {
                return res.status(400).json({ error: '只能将您可访问的模型设为默认' });
            }
        }

        db.prepare('UPDATE users SET default_model_id = ? WHERE id = ?').run(parsedModelId, req.user.id);
        const changed = parsedModelId === null ? '清空个人默认模型' : `模型ID: ${parsedModelId}`;
        logAction(req, '修改个人默认模型', changed);
        res.json({ success: true, personalDefaultModelId: parsedModelId });
    }));

    router.put('/admin/settings/memory', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const value = toMemorySettingValue(MEMORY_CONFIG_KEYS.threshold, req.body?.memory_threshold ?? req.body?.threshold);
        db.prepare(`
            INSERT INTO app_settings (key, value, updated_at, updated_by)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at,
                updated_by = excluded.updated_by
        `).run(MEMORY_CONFIG_KEYS.threshold, value, getBeijingTimestamp(), req.user.id);

        logAction(req, 'UPDATE_MEMORY_THRESHOLD', `${MEMORY_CONFIG_KEYS.threshold}=${value}`);
        const settings = getSettings();
        res.json({
            success: true,
            memoryConfig: getMemoryConfig(settings),
            runtimeConfig: buildRuntimeConfigSnapshot(),
            apiAccessEnabled: getApiAccessSetting(),
            settings
        });
    }));

    router.put('/admin/settings/runtime', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const result = saveRuntimeConfig(req.body || {}, req.user?.id || null);
        if (result.error) return res.status(400).json({ error: result.error });

        let modelEndpointRuntime = [];
        let knowledgeIndexQueue = null;
        let agentQueue = null;
        let memoryCompressionConcurrency = null;
        let globalAiConcurrency = null;

        try {
            globalAiConcurrency = syncGlobalAiConcurrencySettings();
            modelEndpointRuntime = getModelEndpointRuntimeStatus();
            agentQueue = syncAgentRuntimeConcurrency();
            knowledgeIndexQueue = syncKnowledgeDocumentIndexConcurrency();
            memoryCompressionConcurrency = syncMemoryCompressionConcurrency();
        } catch (e) {
            req.log?.warn({ err: e.message }, '运行时配置保存后的同步刷新失败');
        }

        if (result.changed.length > 0) {
            logAction(req, 'UPDATE_RUNTIME_SETTINGS', result.changed.join('；'));
        }

        res.json({
            success: true,
            runtimeConfig: result.config,
            changed: result.changed,
            globalAiConcurrency,
            modelEndpointRuntime,
            agentQueue,
            knowledgeIndexQueue,
            memoryCompressionConcurrency
        });
    }));

    router.put('/admin/settings', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        if (!isSuperAdmin(req.user)) {
            return res.status(403).json({ error: '只有 admin 权限层级可以修改系统全局设置。' });
        }
        const updates = req.body || {};
        const stmt = db.prepare(`
            INSERT INTO app_settings (key, value, updated_at, updated_by)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at,
                updated_by = excluded.updated_by
        `);

        const changed = [];
        for (const key of Object.keys(updates)) {
            if (!allowedSettings.has(key)) continue;
            const value = toSettingValue(key, updates[key]);
            if (key === 'default_model_id' && value) {
                const globalModel = db.prepare('SELECT id FROM models WHERE id = ? AND user_id IS NULL').get(value);
                if (!globalModel) {
                    throw new Error('系统默认模型只能选择全局模型，不能选择用户私有模型');
                }
            }
            if (key === RAG_CONFIG_KEYS.embeddingApiUrl && value) {
                await assertSafeOutboundUrl(value, req.user);
            }
            if (key === RAG_CONFIG_KEYS.embeddingApiKey && !value) continue;
            stmt.run(key, value, getBeijingTimestamp(), req.user.id);
            changed.push(key === RAG_CONFIG_KEYS.embeddingApiKey ? `${key}=********` : `${key}=${value}`);
        }

        if (changed.length > 0) {
            logAction(req, '修改系统设置', changed.join('，'));
            if (changed.some(item => item.startsWith('rag_'))) {
                clearAllRagCache();
            }
        }

        const settings = getSettings();
        res.json({
            success: true,
            ragEnabled: true,
            ragConfig: getRagConfig(),
            memoryConfig: getMemoryConfig(settings),
            runtimeConfig: buildRuntimeConfigSnapshot(),
            apiAccessEnabled: getApiAccessSetting(),
            embeddingConfig: getPublicEmbeddingConfig(),
            defaultModelId: settings.default_model_id?.value || null,
            personalDefaultModelId: req.user?.default_model_id || null,
            settings
        });
    }));

    router.post('/settings/password', authMiddleware, asyncHandler(async (req, res) => {
        const { oldPassword, newPassword } = req.body;
        if (!oldPassword || !newPassword) {
            return res.status(400).json({ error: '旧密码和新密码均不能为空' });
        }

        const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
        const bcrypt = require('bcryptjs');
        if (!bcrypt.compareSync(oldPassword, user.password_hash)) {
            return res.status(400).json({ error: '旧密码错误' });
        }

        const { validatePassword } = require('../auth');
        try {
            validatePassword(newPassword);
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }

        const newHash = bcrypt.hashSync(newPassword, 10);
        db.transaction(() => {
            db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);
            return stmts.deleteUserRefreshTokens.run(req.user.id);
        })();

        logAction(req, '修改密码', '用户自主修改了登录密码');
        res.json({ success: true, message: '密码修改成功' });
    }));

    return router;
}

function isSettingEnabled(key) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row?.value === 'true';
}

module.exports = {
    createSettingsRouter,
    isSettingEnabled,
    buildEmbeddingModelListUrls,
    extractEmbeddingModelIds
};
