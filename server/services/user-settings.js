const { getBeijingTimestamp } = require('../time');
const { query, queryOne, execute } = require('../db/client');

const cache = new Map();
let cacheLoaded = false;
let cacheLoadingPromise = null;

function normalizeUserId(userId) {
    const normalized = Number.parseInt(userId, 10);
    return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

function getCacheKey(userId, key) {
    return `${userId}:${String(key).trim()}`;
}

function upsertCacheRow(row) {
    const userId = normalizeUserId(row?.user_id);
    const key = String(row?.key || '').trim();
    if (!userId || !key) return;
    cache.set(getCacheKey(userId, key), {
        user_id: userId,
        key,
        value: String(row?.value ?? ''),
        updated_at: row?.updated_at || null
    });
}

function removeCacheRow(userId, key) {
    const normalizedUserId = normalizeUserId(userId);
    const normalizedKey = String(key || '').trim();
    if (!normalizedUserId || !normalizedKey) return;
    cache.delete(getCacheKey(normalizedUserId, normalizedKey));
}

function getCachedRow(userId, key) {
    const normalizedUserId = normalizeUserId(userId);
    const normalizedKey = String(key || '').trim();
    if (!normalizedUserId || !normalizedKey) return null;
    return cache.get(getCacheKey(normalizedUserId, normalizedKey)) || null;
}

async function loadUserSettingsCache() {
    try {
        const rows = await query('SELECT user_id, key, value, updated_at FROM user_settings ORDER BY user_id ASC, key ASC');
        cache.clear();
        (rows || []).forEach(upsertCacheRow);
        cacheLoaded = true;
    } catch (_e) {
        // 表结构尚未准备就绪时允许静默失败，后续写入会再次刷新缓存。
    }
}

async function refreshUserSettingsCache() {
    const pending = cacheLoadingPromise;
    if (pending) await pending.catch(() => {});
    await loadUserSettingsCache();
}

async function refreshUserSettingsCacheForUser(userId) {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) return;
    const pending = cacheLoadingPromise;
    if (pending) await pending.catch(() => {});
    try {
        const rows = await query(
            'SELECT user_id, key, value, updated_at FROM user_settings WHERE user_id = ? ORDER BY key ASC',
            [normalizedUserId]
        );
        for (const key of [...cache.keys()]) {
            if (key.startsWith(`${normalizedUserId}:`)) cache.delete(key);
        }
        (rows || []).forEach(upsertCacheRow);
        cacheLoaded = true;
    } catch (_e) {
        // ignore
    }
}

function ensureUserSettingsCacheLoaded() {
    if (!cacheLoaded && !cacheLoadingPromise) {
        cacheLoadingPromise = loadUserSettingsCache().finally(() => {
            cacheLoadingPromise = null;
        });
    }
}

function getUserSettingRow(userId, key) {
    const normalizedUserId = normalizeUserId(userId);
    const normalizedKey = String(key || '').trim();
    if (!normalizedUserId || !normalizedKey) return null;
    ensureUserSettingsCacheLoaded();
    return getCachedRow(normalizedUserId, normalizedKey);
}

async function getUserSettingRowAsync(userId, key) {
    const normalizedUserId = normalizeUserId(userId);
    const normalizedKey = String(key || '').trim();
    if (!normalizedUserId || !normalizedKey) return null;
    const cached = getCachedRow(normalizedUserId, normalizedKey);
    if (cached) return cached;
    try {
        const row = await queryOne(
            'SELECT user_id, key, value, updated_at FROM user_settings WHERE user_id = ? AND key = ?',
            [normalizedUserId, normalizedKey]
        );
        if (row) upsertCacheRow(row);
        return row || null;
    } catch (_e) {
        return null;
    }
}

function getUserSettingValue(userId, key) {
    return getUserSettingRow(userId, key)?.value;
}

async function getUserSettingValueAsync(userId, key) {
    return (await getUserSettingRowAsync(userId, key))?.value;
}

async function setUserSettingAsync(userId, key, value, options = {}) {
    const normalizedUserId = normalizeUserId(userId);
    const normalizedKey = String(key || '').trim();
    if (!normalizedUserId || !normalizedKey) return null;
    const updatedAt = options.updatedAt || getBeijingTimestamp();
    const normalizedValue = String(value ?? '');
    const row = await queryOne(`
        INSERT INTO user_settings (user_id, key, value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        RETURNING user_id, key, value, updated_at
    `, [normalizedUserId, normalizedKey, normalizedValue, updatedAt]);
    if (row) upsertCacheRow(row);
    return row || null;
}

async function deleteUserSettingAsync(userId, key) {
    const normalizedUserId = normalizeUserId(userId);
    const normalizedKey = String(key || '').trim();
    if (!normalizedUserId || !normalizedKey) return false;
    removeCacheRow(normalizedUserId, normalizedKey);
    await execute('DELETE FROM user_settings WHERE user_id = ? AND key = ?', [normalizedUserId, normalizedKey]);
    return true;
}

module.exports = {
    deleteUserSettingAsync,
    getUserSettingRow,
    getUserSettingRowAsync,
    getUserSettingValue,
    getUserSettingValueAsync,
    refreshUserSettingsCache,
    refreshUserSettingsCacheForUser,
    setUserSettingAsync
};
