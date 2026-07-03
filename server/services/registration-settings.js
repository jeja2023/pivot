const { getAppSettingValue, setAppSetting } = require('./app-settings');

const PUBLIC_REGISTRATION_SETTING_KEY = 'allow_public_registration';

function parseBooleanSetting(value) {
    return String(value || '').trim().toLowerCase() === 'true';
}

function getPublicRegistrationSetting() {
    const value = getAppSettingValue(PUBLIC_REGISTRATION_SETTING_KEY);
    if (value !== undefined) return parseBooleanSetting(value);
    return process.env.ALLOW_PUBLIC_REGISTRATION === 'true';
}

function setPublicRegistrationSetting(enabled, updatedBy) {
    const value = enabled ? 'true' : 'false';
    setAppSetting(PUBLIC_REGISTRATION_SETTING_KEY, value, { updatedBy: updatedBy || null });
    return getPublicRegistrationSetting();
}

module.exports = {
    PUBLIC_REGISTRATION_SETTING_KEY,
    getPublicRegistrationSetting,
    setPublicRegistrationSetting
};
