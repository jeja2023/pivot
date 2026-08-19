const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

// 内存缓存：用于高频热路径的快速同步读取
const settingsCache = new Map();
let cacheLoaded = false;
let cacheLoadingPromise = null;

async function loadAppSettingsCache() {
    try {
        const rows = await query('SELECT key, value, updated_at, updated_by FROM app_settings ORDER BY key ASC');
        settingsCache.clear();
        (rows || []).forEach(row => {
            settingsCache.set(row.key, row);
        });
        cacheLoaded = true;
    } catch (e) {
        // 系统初始化阶段表结构可能尚未就绪
    }
}

async function refreshAppSettingsCache() {
    const pending = cacheLoadingPromise;
    if (pending) await pending.catch(() => {});
    await loadAppSettingsCache();
}

function ensureCacheLoaded() {
    if (!cacheLoaded && !cacheLoadingPromise) {
        cacheLoadingPromise = loadAppSettingsCache().finally(() => {
            cacheLoadingPromise = null;
        });
    }
}

// 初始缓存加载触发器
ensureCacheLoaded();

function getAppSettingRow(key) {
    ensureCacheLoaded();
    return settingsCache.get(key) || null;
}

function getAppSettingValue(key) {
    const row = getAppSettingRow(key);
    return row ? row.value : undefined;
}

function getAppSettingRows() {
    ensureCacheLoaded();
    return Array.from(settingsCache.values());
}

function getAppSettingsMap() {
    const settings = {};
    getAppSettingRows().forEach(row => {
        settings[row.key] = {
            value: row.value,
            enabled: row.value === 'true',
            updatedAt: row.updated_at,
            updatedBy: row.updated_by
        };
    });
    return settings;
}

async function getAppSettingRowAsync(key) {
    const row = await queryOne(
        'SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?',
        [key]
    );
    if (row) {
        settingsCache.set(key, row);
    }
    return row || null;
}

async function ensureAppSettingAsync(key, value, options = {}) {
    const existing = await getAppSettingRowAsync(key);
    if (existing) return { inserted: false, row: existing };
    const updatedAt = options.updatedAt || getBeijingTimestamp();
    await execute(
        'INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO NOTHING',
        [key, String(value), updatedAt, options.updatedBy || null]
    );
    return { inserted: true, row: await getAppSettingRowAsync(key) };
}

async function setAppSettingAsync(key, value, options = {}) {
    const pending = cacheLoadingPromise;
    if (pending) await pending.catch(() => {});
    const updatedAt = options.updatedAt || getBeijingTimestamp();
    const row = await queryOne(
        `INSERT INTO app_settings (key, value, updated_at, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = EXCLUDED.updated_at,
            updated_by = EXCLUDED.updated_by
         RETURNING key, value, updated_at, updated_by`,
        [key, String(value), updatedAt, options.updatedBy || null]
    );
    if (row) {
        settingsCache.set(key, row);
    }
    return row || null;
}

function setAppSetting(key, value, options = {}) {
    const updatedAt = options.updatedAt || getBeijingTimestamp();
    const row = { key, value: String(value), updated_at: updatedAt, updated_by: options.updatedBy || null };
    settingsCache.set(key, row);
    setAppSettingAsync(key, value, options).catch(() => {});
    return row;
}

function ensureAppSetting(key, value, options = {}) {
    const existing = getAppSettingRow(key);
    if (existing) return { inserted: false, row: existing };
    const row = setAppSetting(key, value, options);
    return { inserted: true, row };
}

async function deleteAppSettingAsync(key) {
    settingsCache.delete(key);
    await execute('DELETE FROM app_settings WHERE key = ?', [key]);
    return true;
}

function deleteAppSetting(key) {
    settingsCache.delete(key);
    deleteAppSettingAsync(key).catch(() => {});
    return true;
}

async function getAppSettingsMapAsync() {
    await refreshAppSettingsCache();
    return getAppSettingsMap();
}

function isAppSettingsConflictTargetError() {
    return false;
}

module.exports = {
    deleteAppSetting,
    deleteAppSettingAsync,
    ensureAppSetting,
    ensureAppSettingAsync,
    getAppSettingRow,
    getAppSettingRowAsync,
    getAppSettingRows,
    getAppSettingsMap,
    getAppSettingsMapAsync,
    getAppSettingValue,
    isAppSettingsConflictTargetError,
    refreshAppSettingsCache,
    setAppSetting,
    setAppSettingAsync
};
