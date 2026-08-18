/* 模型业务逻辑层 Model Service Layer */
const { db } = require('../db');
const { encryptSecret, decryptSecret } = require('../security');
const { normalizeTokenUsage } = require('./token-accounting');
const { normalizePriceCurrency, normalizePriceValue } = require('./model-costs');
const { isSuperAdmin } = require('../permissions');
const { getBeijingTimestamp } = require('../time');
const {
    enqueueModelUsageEvent,
    getPendingModelUsageTotal
} = require('./db-write-queue');

const modelListFields = "id, user_id, name, url, model_name, is_default, daily_token_limit, allowed_units, monitor_url, max_input_tokens, max_tokens, max_concurrent, supports_vision, supports_reasoning, chat_thinking_enabled, input_price_per_million, output_price_per_million, price_currency, created_at, (CASE WHEN api_key IS NOT NULL AND length(api_key) > 0 THEN '********' ELSE '' END) AS api_key";

const normalizeTags = (value) => String(value || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(',');

function normalizeBooleanFlag(value) {
    return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

// 单个 token 上限字段的范围校验：留空 -> null（不限）；其余必须是 0~上限 的整数。
// 0 视为”不设”（与上下文预算把 0 当无界一致）。非法值返回 { error }，由路由转 400。
// 严格数字校验：拒绝 “123abc” 等部分数字（与前端 parseTokenAmount 的宽松解析拉齐后端防护标准）。
const MAX_MODEL_TOKEN_LIMIT = 20000000;
function normalizeModelTokenLimit(raw, label) {
    if (raw === undefined || raw === null || raw === '') return { value: null };
    const parsed = Number.parseInt(raw, 10);
    // 严格校验：parseInt(“123abc”)=123 但我们要求纯数字，所以加 String(parsed) !== String(raw).trim() 防御
    if (!Number.isFinite(parsed) || String(parsed) !== String(raw).trim()) {
        return { error: `${label}必须是数字` };
    }
    if (parsed < 0) return { error: `${label}不能为负数` };
    if (parsed === 0) return { value: null };
    if (parsed > MAX_MODEL_TOKEN_LIMIT) return { error: `${label}超出允许范围（最大 ${MAX_MODEL_TOKEN_LIMIT}）` };
    return { value: parsed };
}

// 统一校验模型的三项 token 设置，含范围与相互关系（输入/输出上限须小于上下文窗口）。
// 返回 { values: { maxInputTokens, maxTokens, contextWindowTokens } } 或 { error }。
function validateModelTokenSettings(body = {}) {
    const input = normalizeModelTokenLimit(body.max_input_tokens, '输入 Token 上限');
    if (input.error) return { error: input.error };
    const output = normalizeModelTokenLimit(body.max_tokens, '输出 Token 上限');
    if (output.error) return { error: output.error };
    const window = normalizeModelTokenLimit(body.context_window_tokens, '上下文窗口');
    if (window.error) return { error: window.error };

    if (window.value !== null) {
        if (input.value !== null && input.value >= window.value) {
            return { error: '输入 Token 上限应小于上下文窗口' };
        }
        if (output.value !== null && output.value >= window.value) {
            return { error: '输出 Token 上限应小于上下文窗口' };
        }
    }
    return {
        values: {
            maxInputTokens: input.value,
            maxTokens: output.value,
            contextWindowTokens: window.value
        }
    };
}

function modelSupportsVision(model) {
    return normalizeBooleanFlag(model?.supports_vision) === 1;
}

function modelSupportsReasoning(model) {
    return normalizeBooleanFlag(model?.supports_reasoning) === 1;
}

function shouldDisableChatThinking(model) {
    return modelSupportsReasoning(model) && normalizeBooleanFlag(model?.chat_thinking_enabled) !== 1;
}

function isChatThinkingEnabled(model) {
    return modelSupportsReasoning(model) && !shouldDisableChatThinking(model);
}

function contentContainsVisionInput(content) {
    if (Array.isArray(content)) {
        return content.some(part => {
            if (!part || typeof part !== 'object') return false;
            if (part.type === 'image_url' || part.type === 'input_image') return true;
            if (part.image_url) return true;
            return contentContainsVisionInput(part.content);
        });
    }
    return /!\[[^\]]*]\((?:\/uploads\/(?:[^()]|\([^)]*\))+|data:image\/[^)]+|https?:\/\/[^)\s]+\.(?:png|jpe?g|gif|webp|bmp)(?:[?#][^)\s]*)?)\)/i.test(String(content || ''));
}

function messagesContainVisionInput(messages) {
    return Array.isArray(messages) && messages.some(message => contentContainsVisionInput(message?.content));
}

function getAccessibleModel(modelId, user) {
    let model;
    if (modelId) {
        const isNumeric = /^\d+$/.test(String(modelId));
        if (isSuperAdmin(user)) {
            // 管理员可以按 ID 或 model_name 查找
            const sql = isNumeric ?
                "SELECT * FROM models WHERE COALESCE(status, 'active') = 'active' AND (id = ? OR model_name = ?) AND (user_id IS NULL OR user_id = ?)" :
                "SELECT * FROM models WHERE COALESCE(status, 'active') = 'active' AND model_name = ? AND (user_id IS NULL OR user_id = ?)";
            const params = isNumeric ? [modelId, modelId, user.id] : [modelId, user.id];
            model = db.prepare(sql).get(...params);
        } else {
            // 普通用户只能查找自己有权访问的模型 (按 ID 或 model_name)
            const sql = isNumeric ?
                "SELECT * FROM models WHERE COALESCE(status, 'active') = 'active' AND (id = ? OR model_name = ?) AND (user_id IS NULL OR user_id = ?)" :
                "SELECT * FROM models WHERE COALESCE(status, 'active') = 'active' AND model_name = ? AND (user_id IS NULL OR user_id = ?)";
            const params = isNumeric ? [modelId, modelId, user.id] : [modelId, user.id];
            model = db.prepare(sql).get(...params);
        }
    } else {
        model = db.prepare("SELECT * FROM models WHERE COALESCE(status, 'active') = 'active' AND is_default = 1 AND user_id IS NULL").get();
    }
    if (!model) return null;
    if (model.api_key) {
        try {
            model.api_key = decryptSecret(model.api_key);
        } catch (e) {
            model.api_key = '';
            model.secret_error = e.message || '模型密钥解密失败';
        }
    }
    if (model.user_id === user.id) return model;
    if (!model.user_id && model.allowed_units) {
        const units = model.allowed_units.split(',').map(u => u.trim()).filter(Boolean);
        const userUnit = (user.unit || '').trim();
        if (!userUnit || !units.includes(userUnit)) return null;
    }
    return model;
}

function getUserRunnableModels(user) {
    if (!user?.id) return [];
    const rows = db.prepare(`
        SELECT *
        FROM models
        WHERE COALESCE(status, 'active') = 'active'
          AND (user_id IS NULL OR user_id = ?)
        ORDER BY is_default DESC, id ASC
    `).all(user.id);

    return rows.filter(model => {
        if (model.user_id === user.id) return true;
        if (model.user_id) return false;
        if (!model.allowed_units) return true;
        const units = model.allowed_units.split(',').map(unit => unit.trim()).filter(Boolean);
        const userUnit = (user.unit || '').trim();
        return Boolean(userUnit && units.includes(userUnit));
    });
}

function getRunnableModelForUser(modelId, user) {
    if (!modelId || !user?.id) return null;
    const isNumeric = /^\d+$/.test(String(modelId));
    const sql = isNumeric
        ? `SELECT * FROM models WHERE COALESCE(status, 'active') = 'active' AND (id = ? OR model_name = ?) AND (user_id IS NULL OR user_id = ?)`
        : `SELECT * FROM models WHERE COALESCE(status, 'active') = 'active' AND model_name = ? AND (user_id IS NULL OR user_id = ?)`;
    const params = isNumeric ? [modelId, modelId, user.id] : [modelId, user.id];
    const model = db.prepare(sql).get(...params);
    if (!model) return null;
    if (model.user_id && model.user_id !== user.id) return null;
    if (!model.user_id && model.allowed_units) {
        const units = model.allowed_units.split(',').map(unit => unit.trim()).filter(Boolean);
        const userUnit = (user.unit || '').trim();
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

function getModelDailyUsage(userId, modelId) {
    const todayPrefix = getBeijingTimestamp().slice(0, 10);
    const messageTokens = db.prepare(`
        SELECT COALESCE(SUM(token_count), 0) AS tokens
        FROM messages
        WHERE user_id = ? AND model_id = ? AND deleted_at IS NULL AND date(created_at) = date('now', '+8 hours')
    `).get(userId, modelId).tokens || 0;
    const eventTokens = db.prepare(`
        SELECT COALESCE(SUM(token_count), 0) AS tokens
        FROM model_usage_events
        WHERE user_id = ? AND model_id = ? AND date(created_at) = date('now', '+8 hours')
    `).get(userId, modelId).tokens || 0;
    return messageTokens + eventTokens + getPendingModelUsageTotal(userId, modelId, todayPrefix);
}

function recordModelTokenUsage(userId, modelId, tokenCount, source = 'api', inputTokens = 0, outputTokens = 0) {
    const usage = normalizeTokenUsage({ inputTokens, outputTokens, totalTokens: tokenCount });
    if (!userId || !modelId || usage.totalTokens <= 0) return;
    enqueueModelUsageEvent({
        userId,
        modelId,
        source: String(source || 'api').slice(0, 40),
        tokenCount: usage.totalTokens,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        createdAt: getBeijingTimestamp()
    });
}

function getOrCreateEmbeddingUsageModel({ userId = null, url = '', model = '' } = {}) {
    const ownerId = userId ? Number.parseInt(userId, 10) || null : null;
    const safeUrl = String(url || '').trim() || 'embedding://未配置';
    const safeModel = String(model || '').trim() || 'embedding';
    const existing = ownerId
        ? db.prepare("SELECT id FROM models WHERE status = 'usage_only' AND user_id = ? AND url = ? AND model_name = ?").get(ownerId, safeUrl, safeModel)
        : db.prepare("SELECT id FROM models WHERE status = 'usage_only' AND user_id IS NULL AND url = ? AND model_name = ?").get(safeUrl, safeModel);
    if (existing) return existing.id;

    const info = db.prepare(`
        INSERT INTO models (user_id, name, url, api_key, model_name, status, created_at)
        VALUES (?, ?, ?, '', ?, 'usage_only', datetime('now', '+8 hours'))
    `).run(ownerId, `向量模型: ${safeModel}`, safeUrl, safeModel);
    return info.lastInsertRowid;
}

function migrateModelSecrets() {
    const models = db.prepare("SELECT id, api_key FROM models WHERE api_key IS NOT NULL AND api_key != '' AND api_key NOT LIKE 'enc:v1:%'").all();
    const update = db.prepare('UPDATE models SET api_key = ? WHERE id = ?');
    models.forEach(model => update.run(encryptSecret(model.api_key), model.id));
    if (models.length > 0) {
        const { logger } = require('../logger');
        logger.info({ count: models.length }, '安全升级: 模型密钥加密完成');
    }
}

function getUserAccessibleModels(user) {
    let sql = "SELECT * FROM models WHERE status = 'active'";
    let params = [];
    sql += ' AND (user_id IS NULL OR user_id = ?)';
    params.push(user.id);
    let models = db.prepare(sql).all(...params);

    return models.filter(m => {
        if (m.user_id === user.id) return true;
        if (!m.user_id && m.allowed_units) {
            const units = m.allowed_units.split(',').map(u => u.trim()).filter(Boolean);
            const userUnit = (user.unit || '').trim();
            if (!userUnit || !units.includes(userUnit)) return false;
        }
        return true;
    });
}

module.exports = {
    modelListFields,
    normalizeTags,
    normalizeBooleanFlag,
    normalizeModelTokenLimit,
    validateModelTokenSettings,
    MAX_MODEL_TOKEN_LIMIT,
    normalizePriceCurrency,
    normalizePriceValue,
    modelSupportsVision,
    modelSupportsReasoning,
    shouldDisableChatThinking,
    isChatThinkingEnabled,
    contentContainsVisionInput,
    messagesContainVisionInput,
    getAccessibleModel,
    getRunnableModelForUser,
    getUserRunnableModels,
    getModelDailyUsage,
    getOrCreateEmbeddingUsageModel,
    recordModelTokenUsage,
    getUserAccessibleModels,
    migrateModelSecrets
};
