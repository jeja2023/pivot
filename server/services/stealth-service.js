const crypto = require('crypto');
const { getAppSettingValue, setAppSettingAsync } = require('./app-settings');

const STEALTH_SETTING_ENABLED_KEY = 'stealth_mode_enabled';
const STEALTH_SETTING_SECRET_KEY = 'stealth_secret';

let cachedSecret = '';
let isSecretInitialized = false;
let memoryEnabled = false;

function generateRandomSecret() {
    return crypto.randomBytes(32).toString('hex');
}

function getStealthSecret() {
    if (process.env.PIVOT_STEALTH_SECRET) {
        return process.env.PIVOT_STEALTH_SECRET.trim();
    }
    const dbValue = getAppSettingValue(STEALTH_SETTING_SECRET_KEY);
    if (dbValue && typeof dbValue === 'string' && dbValue.trim()) {
        cachedSecret = dbValue.trim();
        return cachedSecret;
    }
    if (cachedSecret) {
        return cachedSecret;
    }
    if (!isSecretInitialized) {
        isSecretInitialized = true;
        const newSecret = generateRandomSecret();
        cachedSecret = newSecret;
        // 异步持久化至数据库，不阻塞当前请求
        setAppSettingAsync(STEALTH_SETTING_SECRET_KEY, newSecret, { updatedBy: null }).catch(() => {});
    }
    return cachedSecret || 'pivot-default-stealth-secret';
}

function isStealthModeEnabled() {
    if (process.env.PIVOT_STEALTH_MODE !== undefined) {
        const envVal = String(process.env.PIVOT_STEALTH_MODE).trim().toLowerCase();
        if (envVal === 'true' || envVal === '1') return true;
        if (envVal === 'false' || envVal === '0') return false;
    }
    const dbVal = getAppSettingValue(STEALTH_SETTING_ENABLED_KEY);
    if (dbVal !== undefined) {
        return dbVal === 'true' || dbVal === true;
    }
    return memoryEnabled;
}

function generateStealthSignature(timestamp, secret) {
    const key = secret || getStealthSecret();
    return crypto.createHmac('sha256', key).update(String(timestamp)).digest('hex');
}

function verifyStealthRequest(req) {
    if (!isStealthModeEnabled()) {
        return true;
    }

    const clientTime = req.headers['x-pivot-stealth-time'] || req.headers['x-pivot-stealth-timestamp'];
    const clientToken = req.headers['x-pivot-stealth-token'] || req.headers['x-pivot-stealth-signature'];

    if (!clientTime || !clientToken || typeof clientToken !== 'string') {
        return false;
    }

    const timeNum = Number(clientTime);
    if (!Number.isFinite(timeNum)) {
        return false;
    }

    // 允许 120 秒内的时间漂移，防止重放攻击
    const now = Date.now();
    if (Math.abs(now - timeNum) > 120000) {
        return false;
    }

    const expected = generateStealthSignature(timeNum, getStealthSecret());

    try {
        const tokenBuf = Buffer.from(clientToken, 'utf8');
        const expectedBuf = Buffer.from(expected, 'utf8');
        if (tokenBuf.length !== expectedBuf.length) {
            return false;
        }
        return crypto.timingSafeEqual(tokenBuf, expectedBuf);
    } catch (_) {
        return false;
    }
}

async function getStealthConfig() {
    const enabled = isStealthModeEnabled();
    const secret = getStealthSecret();
    const isEnvOverridden = process.env.PIVOT_STEALTH_MODE !== undefined;
    return {
        enabled,
        secret,
        envOverridden: isEnvOverridden
    };
}

async function setStealthConfigAsync({ enabled, secret, regenerateSecret, userId }) {
    if (regenerateSecret === true) {
        const newSecret = generateRandomSecret();
        cachedSecret = newSecret;
        try {
            await setAppSettingAsync(STEALTH_SETTING_SECRET_KEY, newSecret, { updatedBy: userId });
        } catch (_) {}
    } else if (typeof secret === 'string' && secret.trim().length >= 16) {
        cachedSecret = secret.trim();
        try {
            await setAppSettingAsync(STEALTH_SETTING_SECRET_KEY, cachedSecret, { updatedBy: userId });
        } catch (_) {}
    }

    if (typeof enabled === 'boolean') {
        memoryEnabled = enabled;
        try {
            await setAppSettingAsync(STEALTH_SETTING_ENABLED_KEY, enabled ? 'true' : 'false', { updatedBy: userId });
        } catch (_) {}
    }

    return getStealthConfig();
}

module.exports = {
    STEALTH_SETTING_ENABLED_KEY,
    STEALTH_SETTING_SECRET_KEY,
    generateStealthSignature,
    getStealthConfig,
    getStealthSecret,
    isStealthModeEnabled,
    setStealthConfigAsync,
    verifyStealthRequest
};
