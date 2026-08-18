const { db } = require('../db/connection');
const { getBeijingTimestamp } = require('../time');

function isAppSettingsConflictTargetError(error) {
    return /ON CONFLICT clause/i.test(error?.message || '');
}

function isMissingAppSettingsTable(error) {
    return /no such table:\s*app_settings/i.test(error?.message || '');
}

function getAppSettingRow(key) {
    if (!db) return null;
    try {
        return db.prepare(`
            SELECT key, value, updated_at, updated_by
            FROM app_settings
            WHERE key = ?
            ORDER BY
                CASE WHEN updated_at IS NULL OR updated_at = '' THEN 0 ELSE 1 END DESC,
                updated_at DESC,
                rowid DESC
            LIMIT 1
        `).get(key) || null;
    } catch (e) {
        if (isMissingAppSettingsTable(e)) return null;
        throw e;
    }
}

function getAppSettingValue(key) {
    const row = getAppSettingRow(key);
    return row ? row.value : undefined;
}

function getAppSettingRows() {
    if (!db) return [];
    try {
        const rows = db.prepare(`
            SELECT key, value, updated_at, updated_by
            FROM app_settings
            ORDER BY
                key ASC,
                CASE WHEN updated_at IS NULL OR updated_at = '' THEN 0 ELSE 1 END ASC,
                updated_at ASC,
                rowid ASC
        `).all();
        const latestByKey = new Map();
        rows.forEach(row => {
            latestByKey.set(row.key, row);
        });
        return Array.from(latestByKey.values());
    } catch (e) {
        if (isMissingAppSettingsTable(e)) return [];
        throw e;
    }
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

function insertAppSetting(key, value, updatedAt, updatedBy = null) {
    return db.prepare(`
        INSERT INTO app_settings (key, value, updated_at, updated_by)
        VALUES (?, ?, ?, ?)
    `).run(key, String(value), updatedAt, updatedBy || null);
}

function ensureAppSetting(key, value, options = {}) {
    const existing = getAppSettingRow(key);
    if (existing) return { inserted: false, row: existing };
    const updatedAt = options.updatedAt || getBeijingTimestamp();
    insertAppSetting(key, value, updatedAt, options.updatedBy || null);
    return { inserted: true, row: getAppSettingRow(key) };
}

function deleteAppSetting(key) {
    try {
        db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
        return true;
    } catch (e) {
        if (isMissingAppSettingsTable(e)) return false;
        throw e;
    }
}

function setAppSetting(key, value, options = {}) {
    const updatedAt = options.updatedAt || getBeijingTimestamp();
    const updatedBy = options.updatedBy || null;
    const args = [key, String(value), updatedAt, updatedBy];
    let legacyAppSettingsMode = false;
    let upsertStmt = null;

    try {
        upsertStmt = db.prepare(`
            INSERT INTO app_settings (key, value, updated_at, updated_by)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at,
                updated_by = excluded.updated_by
        `);
    } catch (e) {
        if (!isAppSettingsConflictTargetError(e)) throw e;
        legacyAppSettingsMode = true;
    }

    const write = () => {
        if (!legacyAppSettingsMode) {
            try {
                upsertStmt.run(...args);
                return;
            } catch (e) {
                if (!isAppSettingsConflictTargetError(e)) throw e;
                legacyAppSettingsMode = true;
            }
        }
        db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
        insertAppSetting(key, value, updatedAt, updatedBy);
    };

    db.transaction(write)();
    return getAppSettingRow(key);
}

const { isPostgres } = require('../db/dialect');
const { query, queryOne, execute } = require('../db/client');

async function getAppSettingRowAsync(key) {
    if (!isPostgres()) return getAppSettingRow(key);
    return await queryOne(
        'SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = $1',
        [key]
    );
}

async function ensureAppSettingAsync(key, value, options = {}) {
    if (!isPostgres()) return ensureAppSetting(key, value, options);
    const existing = await getAppSettingRowAsync(key);
    if (existing) return { inserted: false, row: existing };
    const updatedAt = options.updatedAt || new Date().toISOString();
    await execute(
        'INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING',
        [key, String(value), updatedAt, options.updatedBy || null]
    );
    return { inserted: true, row: await getAppSettingRowAsync(key) };
}

async function setAppSettingAsync(key, value, options = {}) {
    if (!isPostgres()) return setAppSetting(key, value, options);
    const updatedAt = options.updatedAt || new Date().toISOString();
    await execute(
        `INSERT INTO app_settings (key, value, updated_at, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = EXCLUDED.updated_at,
            updated_by = EXCLUDED.updated_by`,
        [key, String(value), updatedAt, options.updatedBy || null]
    );
    return await getAppSettingRowAsync(key);
}

async function getAppSettingsMapAsync() {
    if (!isPostgres()) return getAppSettingsMap();
    const rows = await query('SELECT key, value, updated_at, updated_by FROM app_settings ORDER BY key ASC');
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

module.exports = {
    deleteAppSetting,
    ensureAppSetting,
    ensureAppSettingAsync,
    getAppSettingRow,
    getAppSettingRowAsync,
    getAppSettingRows,
    getAppSettingsMap,
    getAppSettingsMapAsync,
    getAppSettingValue,
    isAppSettingsConflictTargetError,
    setAppSetting,
    setAppSettingAsync
};