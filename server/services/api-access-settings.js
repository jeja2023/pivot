const { getAppSettingValue, setAppSetting } = require('./app-settings');

const API_ACCESS_SETTING_KEY = 'api_access_enabled';

function parseBooleanSetting(value) {
    return String(value || '').trim().toLowerCase() === 'true';
}

function getApiAccessSetting() {
    const value = getAppSettingValue(API_ACCESS_SETTING_KEY);
    if (value !== undefined) return parseBooleanSetting(value);
    return process.env.API_ACCESS_ENABLED !== 'false';
}

function setApiAccessSetting(enabled, updatedBy) {
    const value = enabled ? 'true' : 'false';
    setAppSetting(API_ACCESS_SETTING_KEY, value, { updatedBy: updatedBy || null });
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
