const { db } = require('../db');
const { getBeijingTimestamp } = require('../time');

const PUBLIC_REGISTRATION_SETTING_KEY = 'allow_public_registration';

function parseBooleanSetting(value) {
    return String(value || '').trim().toLowerCase() === 'true';
}

function getPublicRegistrationSetting() {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(PUBLIC_REGISTRATION_SETTING_KEY);
    if (row) return parseBooleanSetting(row.value);
    return process.env.ALLOW_PUBLIC_REGISTRATION === 'true';
}

function setPublicRegistrationSetting(enabled, updatedBy) {
    const value = enabled ? 'true' : 'false';
    db.prepare(`
        INSERT INTO app_settings (key, value, updated_at, updated_by)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by
    `).run(PUBLIC_REGISTRATION_SETTING_KEY, value, getBeijingTimestamp(), updatedBy || null);
    return getPublicRegistrationSetting();
}

module.exports = {
    PUBLIC_REGISTRATION_SETTING_KEY,
    getPublicRegistrationSetting,
    setPublicRegistrationSetting
};
