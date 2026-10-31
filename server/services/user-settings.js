'use strict';

const { getBeijingTimestamp } = require('../time');
const { query, queryOne, execute } = require('../db/client');
const { LruCache } = require('../cache');

// 只缓存按用户和键集合读取的快照，未命中必须等待数据库，不能使用系统默认值。
// 短 TTL 使其他节点的更改可见；大值不进入缓存。
const cache = new LruCache({ max: 512, ttlMs: 5000 });
const pending = new Map();
const copyRows = rows => Object.assign(Object.create(null), Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, { ...row }])));

function normalizeUserId(userId) {
    const normalized = Number.parseInt(userId, 10);
    return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

function invalidate(userId = null) {
    const prefix = userId ? `[${userId},` : null;
    for (const key of cache.map.keys()) if (!prefix || key.startsWith(prefix)) cache.delete(key);
    for (const [key, entry] of pending) {
        if (prefix && !key.startsWith(prefix)) continue;
        entry.invalidated = true;
        pending.delete(key);
    }
}

function releasePending(key, entry) {
    entry.waiters -= 1;
    if (entry.waiters === 0 && pending.get(key) === entry) pending.delete(key);
}

async function getUserSettingsAsync(userId, keys) {
    const id = normalizeUserId(userId);
    if (!id) return Object.create(null);
    const normalizedKeys = [...new Set((keys || []).map(key => String(key || '').trim()).filter(Boolean))].sort();
    if (!normalizedKeys.length) return Object.create(null);
    if (normalizedKeys.length > 64) throw new Error('用户设置查询键数量超出上限');
    const cacheKey = JSON.stringify([id, normalizedKeys]);
    for (;;) {
        const cached = cache.get(cacheKey);
        if (cached) return copyRows(cached);
        let entry = pending.get(cacheKey);
        if (!entry) {
            entry = { invalidated: false, waiters: 0, task: Promise.resolve().then(() => query('SELECT user_id, key, value, updated_at FROM user_settings WHERE user_id = ? AND key = ANY(?::text[])', [id, normalizedKeys])) };
            pending.set(cacheKey, entry);
        }
        entry.waiters += 1;
        let rows;
        try { rows = await entry.task; } catch (error) {
            releasePending(cacheKey, entry);
            throw error;
        }
        // 写入或显式刷新可能与查询交错；过期的在途结果不能重新填充缓存。
        if (entry.invalidated) { releasePending(cacheKey, entry); continue; }
        const result = Object.create(null);
        let bytes = 0;
        for (const row of rows || []) {
            const key = String(row.key || '');
            if (!normalizedKeys.includes(key)) continue;
            const value = String(row.value ?? '');
            bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
            result[key] = { user_id: id, key, value, updated_at: row.updated_at || null };
        }
        if (bytes <= 64 * 1024) cache.set(cacheKey, result);
        releasePending(cacheKey, entry);
        return copyRows(result);
    }
}

async function getUserSettingRowAsync(userId, key) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return null;
    return (await getUserSettingsAsync(userId, [normalizedKey]))[normalizedKey] || null;
}

async function getUserSettingValueAsync(userId, key) {
    return (await getUserSettingRowAsync(userId, key))?.value;
}

async function refreshUserSettingsCache() { invalidate(); }
async function refreshUserSettingsCacheForUser(userId) { const id = normalizeUserId(userId); if (id) invalidate(id); }

async function setUserSettingAsync(userId, key, value, options = {}) {
    const id = normalizeUserId(userId);
    const normalizedKey = String(key || '').trim();
    if (!id || !normalizedKey) return null;
    invalidate(id);
    try {
        return await queryOne(`
            INSERT INTO user_settings (user_id, key, value, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, key) DO UPDATE SET
                value = excluded.value, updated_at = excluded.updated_at
            RETURNING user_id, key, value, updated_at
        `, [id, normalizedKey, String(value ?? ''), options.updatedAt || getBeijingTimestamp()]);
    } finally { invalidate(id); }
}

async function deleteUserSettingAsync(userId, key) {
    const id = normalizeUserId(userId);
    const normalizedKey = String(key || '').trim();
    if (!id || !normalizedKey) return false;
    invalidate(id);
    try {
        await execute('DELETE FROM user_settings WHERE user_id = ? AND key = ?', [id, normalizedKey]);
        return true;
    } finally { invalidate(id); }
}

module.exports = {
    deleteUserSettingAsync, getUserSettingsAsync, getUserSettingRowAsync, getUserSettingValueAsync,
    refreshUserSettingsCache, refreshUserSettingsCacheForUser, setUserSettingAsync
};
