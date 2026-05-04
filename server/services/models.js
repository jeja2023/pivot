/* 模型业务逻辑层 Model Service Layer */
const { db, stmts } = require('../db');
const { encryptSecret, decryptSecret } = require('../security');

const modelListFields = "id, user_id, name, url, model_name, is_default, daily_token_limit, allowed_units, created_at, (CASE WHEN api_key IS NOT NULL AND length(api_key) > 0 THEN '********' ELSE '' END) AS api_key";

const normalizeTags = (value) => String(value || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(',');

function getAccessibleModel(modelId, user) {
    let model;
    if (modelId) {
        if (user.role === 'admin') {
            model = db.prepare('SELECT * FROM models WHERE id = ?').get(modelId); // Admin query remains flexible
        } else {
            model = db.prepare('SELECT * FROM models WHERE id = ? AND (user_id IS NULL OR user_id = ?)').get(modelId, user.id);
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
    return db.prepare(`
        SELECT COALESCE(SUM(token_count), 0) AS tokens
        FROM messages
        WHERE user_id = ? AND model_id = ? AND date(created_at) = date('now', '+8 hours')
    `).get(userId, modelId).tokens || 0;
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
    getUserAccessibleModels,
    migrateModelSecrets
};
