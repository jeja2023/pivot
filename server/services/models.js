/* 模型业务逻辑层 Model Service Layer */
const { db } = require('../db');
const { encryptSecret, decryptSecret } = require('../security');
const { normalizeTokenUsage } = require('./token-accounting');
const { normalizePriceCurrency, normalizePriceValue } = require('./model-costs');

const modelListFields = "id, user_id, name, url, model_name, is_default, daily_token_limit, allowed_units, monitor_url, max_input_tokens, max_tokens, max_concurrent, supports_vision, supports_reasoning, input_price_per_million, output_price_per_million, price_currency, created_at, (CASE WHEN api_key IS NOT NULL AND length(api_key) > 0 THEN '********' ELSE '' END) AS api_key";

const normalizeTags = (value) => String(value || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(',');

function normalizeBooleanFlag(value) {
    return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

function modelSupportsVision(model) {
    return normalizeBooleanFlag(model?.supports_vision) === 1;
}

function modelSupportsReasoning(model) {
    return normalizeBooleanFlag(model?.supports_reasoning) === 1;
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
    return /!\[[^\]]*]\((?:\/uploads\/|data:image\/|https?:\/\/[^)\s]+\.(?:png|jpe?g|gif|webp|bmp)(?:[?#][^)\s]*)?)[^)\s]*\)/i.test(String(content || ''));
}

function messagesContainVisionInput(messages) {
    return Array.isArray(messages) && messages.some(message => contentContainsVisionInput(message?.content));
}

function getAccessibleModel(modelId, user) {
    let model;
    if (modelId) {
        const isNumeric = /^\d+$/.test(String(modelId));
        if (user.role === 'admin' && user.username === 'admin') {
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
    return messageTokens + eventTokens;
}

function recordModelTokenUsage(userId, modelId, tokenCount, source = 'api', inputTokens = 0, outputTokens = 0) {
    const usage = normalizeTokenUsage({ inputTokens, outputTokens, totalTokens: tokenCount });
    if (!userId || !modelId || usage.totalTokens <= 0) return;
    db.prepare(`
        INSERT INTO model_usage_events (user_id, model_id, source, token_count, input_tokens, output_tokens, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(userId, modelId, String(source || 'api').slice(0, 40), usage.totalTokens, usage.inputTokens, usage.outputTokens);
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
    normalizePriceCurrency,
    normalizePriceValue,
    modelSupportsVision,
    modelSupportsReasoning,
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
