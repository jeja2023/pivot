'use strict';

const crypto = require('node:crypto');
const { readTypedEnv } = require('../../config/env-registry');
const { encryptSecret, decryptSecret, hasSecretEncryptionKey } = require('../../security');
const { speechError } = require('./audio');

const SETTING_KEY = 'speech_recognition_secret_config';
const PURPOSE = 'speech.recognition_configuration';
const FIELDS = {
    enabled: 'PIVOT_SERVER_VOICE_ENABLED', provider: 'PIVOT_VOICE_PROVIDER', endpoint: 'PIVOT_VOICE_ENDPOINT',
    streamEndpoint: 'PIVOT_VOICE_STREAM_ENDPOINT', apiKey: 'PIVOT_VOICE_API_KEY', model: 'PIVOT_VOICE_MODEL',
    allowExternal: 'PIVOT_VOICE_ALLOW_EXTERNAL', hotwords: 'PIVOT_VOICE_HOTWORDS', maxConcurrent: 'PIVOT_VOICE_MAX_CONCURRENT',
    timeoutMs: 'PIVOT_VOICE_TIMEOUT_MS', endSilenceMs: 'PIVOT_VOICE_END_SILENCE_MS', minConfidence: 'PIVOT_VOICE_MIN_CONFIDENCE',
    cpuThreads: 'PIVOT_EMBEDDED_VOICE_CPU_THREADS'
};

function createSpeechSettings({ readEnv = readTypedEnv,
    getValue = key => require('../app-settings').getAppSettingValue(key),
    setValue = (key, value, options) => require('../app-settings').setAppSettingAsync(key, value, options),
    encrypt = encryptSecret, decrypt = decryptSecret, canEncrypt = hasSecretEncryptionKey } = {}) {
    let lastRaw; let cached = null; let cachedError = null; let writes = Promise.resolve();
    function stored() {
        const raw = getValue(SETTING_KEY) || '';
        if (raw === lastRaw) { if (cachedError) throw cachedError; return cached; }
        lastRaw = raw; cached = null; cachedError = null;
        if (raw) {
            try {
                const parsed = JSON.parse(decrypt(raw, PURPOSE));
                if (parsed?.version === 1 && parsed.values && typeof parsed.values === 'object') cached = parsed;
                else throw new Error();
            } catch (_) { cachedError = speechError('保存的语音配置无法解密，请检查服务器加密密钥。', 'VOICE_SETTINGS_UNREADABLE', 503); throw cachedError; }
        }
        return cached;
    }
    function read(name) {
        const field = Object.keys(FIELDS).find(key => FIELDS[key] === name);
        const record = field ? stored() : null;
        return record && Object.hasOwn(record.values, field) ? record.values[field] : readEnv(name);
    }
    function effective() {
        const record = stored();
        return { ...Object.fromEntries(Object.entries(FIELDS).map(([key, name]) => [key, read(name)])),
            revision: record?.revision || 'environment', source: record ? 'settings' : 'environment' };
    }
    function publicConfig({ administrator = false } = {}) {
        let config;
        try { config = effective(); }
        catch (_) { return { enabled: false, provider: 'unavailable', configured: false, canManage: administrator,
            revision: 'unreadable', source: 'settings', error: '保存的语音配置无法读取，请联系管理员检查加密密钥。' }; }
        const { apiKey, ...safe } = config;
        if (!administrator) {
            safe.endpoint = config.endpoint ? '********' : ''; safe.streamEndpoint = config.streamEndpoint ? '********' : '';
            delete safe.hotwords;
        }
        return { ...safe, hasApiKey: Boolean(apiKey), canManage: administrator,
            configured: ['embedded', 'local'].includes(config.provider) || Boolean(config.endpoint && (config.provider === 'gateway' || config.model)) };
    }
    function save(patch, { userId } = {}) {
        const update = writes.then(async () => {
            const previous = effective();
            if (patch.revision !== previous.revision) throw speechError('语音配置已被其他操作更新，请重新加载后再保存。', 'VOICE_SETTINGS_CONFLICT', 409);
            const { validateSpeechSettings } = require('./settings-validation');
            const values = await validateSpeechSettings(patch, previous);
            if (!canEncrypt()) throw speechError('服务器尚未配置数据加密密钥，不能安全保存语音配置。', 'VOICE_SETTINGS_ENCRYPTION_REQUIRED', 409);
            await setValue(SETTING_KEY, encrypt(JSON.stringify({ version: 1, revision: crypto.randomUUID(), values }), PURPOSE), { updatedBy: userId || null });
            lastRaw = undefined;
            return publicConfig({ administrator: true });
        });
        writes = update.catch(() => {});
        return update;
    }
    return { read, effective, publicConfig, save };
}

const speechSettings = createSpeechSettings();
const readSpeechSetting = name => speechSettings.read(name);
module.exports = { createSpeechSettings, speechSettings, readSpeechSetting };
