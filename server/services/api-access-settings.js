const { getBeijingTimestamp } = require('../time');

const API_ACCESS_SETTING_KEY = 'api_access_enabled';

function getDb() {
    return require('../db').db;
}

function parseBooleanSetting(value) {
    return String(value || '').trim().toLowerCase() === 'true';
}

function getApiAccessSetting() {
    const db = getDb();
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(API_ACCESS_SETTING_KEY);
    if (row) return parseBooleanSetting(row.value);
    return process.env.API_ACCESS_ENABLED !== 'false';
}

function setApiAccessSetting(enabled, updatedBy) {
    const db = getDb();
    const value = enabled ? 'true' : 'false';
    db.prepare(`
        INSERT INTO app_settings (key, value, updated_at, updated_by)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by
    `).run(API_ACCESS_SETTING_KEY, value, getBeijingTimestamp(), updatedBy || null);
    return getApiAccessSetting();
}

function createApiAccessGuard({ logAction } = {}) {
    return (req, res, next) => {
        if (getApiAccessSetting()) return next();
        if (typeof logAction === 'function') {
            logAction(req, 'API 接入拦截', `${req.method} ${req.originalUrl || req.url}`);
        }
        return res.status(403).json({
            error: 'API 接入已由管理员关闭'
        });
    };
}

module.exports = {
    API_ACCESS_SETTING_KEY,
    createApiAccessGuard,
    getApiAccessSetting,
    setApiAccessSetting
};
