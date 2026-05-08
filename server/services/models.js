/* 模型业务逻辑层 Model Service Layer */
const { db } = require('../db');
const { encryptSecret, decryptSecret } = require('../security');

const modelListFields = "id, user_id, name, url, model_name, is_default, daily_token_limit, allowed_units, monitor_url, max_concurrent, created_at, (CASE WHEN api_key IS NOT NULL AND length(api_key) > 0 THEN '********' ELSE '' END) AS api_key";

const normalizeTags = (value) => String(value || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(',');

function getAccessibleModel(modelId, user) {
    let model;
    if (modelId) {
        const isNumeric = /^\d+$/.test(String(modelId));
        if (user.role === 'admin') {
            // 管理员可以按 ID 或 model_name 查找
            const sql = isNumeric ? 
                'SELECT * FROM models WHERE id = ? OR model_name = ?' : 
                'SELECT * FROM models WHERE model_name = ?';
            const params = isNumeric ? [modelId, modelId] : [modelId];
            model = db.prepare(sql).get(...params);
        } else {
            // 普通用户只能查找自己有权访问的模型 (按 ID 或 model_name)
            const sql = isNumeric ? 
                'SELECT * FROM models WHERE (id = ? OR model_name = ?) AND (user_id IS NULL OR user_id = ?)' : 
                'SELECT * FROM models WHERE model_name = ? AND (user_id IS NULL OR user_id = ?)';
            const params = isNumeric ? [modelId, modelId, user.id] : [modelId, user.id];
            model = db.prepare(sql).get(...params);
        }
    } else {
        model = db.prepare('SELECT * FROM models WHERE is_default = 1 AND user_id IS NULL').get();
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
    if (user.role === 'admin') return model;
    if (model.user_id === user.id) return model;
    if (!model.user_id && model.allowed_units) {
        const units = model.allowed_units.split(',').map(u => u.trim()).filter(Boolean);
        const userUnit = (user.unit || '').trim();
        if (!userUnit || !units.includes(userUnit)) return null;
    }
    return model;
}

function getModelDailyUsage(userId, modelId) {
    const messageTokens = db.prepare(`
        SELECT COALESCE(SUM(token_count), 0) AS tokens
        FROM messages
        WHERE user_id = ? AND model_id = ? AND date(created_at) = date('now', '+8 hours')
    `).get(userId, modelId).tokens || 0;
    const eventTokens = db.prepare(`
        SELECT COALESCE(SUM(token_count), 0) AS tokens
        FROM model_usage_events
        WHERE user_id = ? AND model_id = ? AND date(created_at) = date('now', '+8 hours')
    `).get(userId, modelId).tokens || 0;
    return messageTokens + eventTokens;
}

function recordModelTokenUsage(userId, modelId, tokenCount, source = 'api') {
    const safeTokens = Math.max(parseInt(tokenCount, 10) || 0, 0);
    if (!userId || !modelId || safeTokens <= 0) return;
    db.prepare(`
        INSERT INTO model_usage_events (user_id, model_id, source, token_count, created_at)
        VALUES (?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(userId, modelId, String(source || 'api').slice(0, 40), safeTokens);
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
    if (user.role !== 'admin') {
        sql += ' AND (user_id IS NULL OR user_id = ?)';
        params.push(user.id);
    }
    let models = db.prepare(sql).all(...params);
    
    if (user.role === 'admin') return models;

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
    getAccessibleModel,
    getModelDailyUsage,
    recordModelTokenUsage,
    getUserAccessibleModels,
    migrateModelSecrets
};
