const crypto = require('crypto');
const { getAppSettingValue, setAppSettingAsync, ensureAppSettingAsync, replaceAppSettingValueIfUnchanged } = require('./app-settings');
const { encryptSecret, decryptSecret } = require('../security');

const STEALTH_SETTING_ENABLED_KEY = 'stealth_mode_enabled';
const STEALTH_SETTING_SECRET_KEY = 'stealth_secret';

let cachedSecret = '';
let isSecretInitialized = false;
let memoryEnabled = false;
let migratingSecret = '';
const SECRET_CONTEXT = 'app_settings.stealth_secret';

function generateRandomSecret() {
    return crypto.randomBytes(32).toString('hex');
}

function getStealthSecret() {
    const dbValue = getAppSettingValue(STEALTH_SETTING_SECRET_KEY);
    if (dbValue && typeof dbValue === 'string' && dbValue.trim()) {
        const stored = dbValue.trim();
        cachedSecret = String(decryptSecret(stored, SECRET_CONTEXT)).trim();
        if (!/^enc:v[12]:/.test(stored) && process.env.DATA_ENCRYPTION_KEY && migratingSecret !== dbValue) {
            migratingSecret = dbValue;
            const encrypted = encryptSecret(stored, SECRET_CONTEXT);
            replaceAppSettingValueIfUnchanged(STEALTH_SETTING_SECRET_KEY, dbValue, encrypted)
                .catch(() => {})
                .finally(() => { if (migratingSecret === dbValue) migratingSecret = ''; });
        }
        return cachedSecret;
    }
    // .env 只作为首次启动/迁移兼容来源；一旦管理员在全局参数页保存新密钥，
    // app_settings 优先，避免旧环境变量把页面修改静默覆盖回去。
    if (process.env.PIVOT_STEALTH_SECRET) {
        return process.env.PIVOT_STEALTH_SECRET.trim();
    }
    if (cachedSecret) {
        return cachedSecret;
    }
    if (!isSecretInitialized) {
        isSecretInitialized = true;
        const newSecret = generateRandomSecret();
        cachedSecret = newSecret;
        // 异步持久化至数据库，不阻塞当前请求
        if (process.env.DATA_ENCRYPTION_KEY) {
            ensureAppSettingAsync(STEALTH_SETTING_SECRET_KEY, encryptSecret(newSecret, SECRET_CONTEXT), { updatedBy: null }).catch(() => {});
        }
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

function generateStealthSignature(timestamp, secret, authority = '') {
    const key = secret || getStealthSecret();
    const payload = authority ? `${timestamp}:${String(authority).toLowerCase()}` : String(timestamp);
    return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

function verifyStealthRequest(req) {
    if (!isStealthModeEnabled()) {
        return true;
    }

    const clientTime = req.headers['x-pivot-stealth-time'] || req.headers['x-pivot-stealth-timestamp'];
    const version = String(req.headers['x-pivot-stealth-version'] || '1');
    const clientToken = version === '2' ? req.headers['x-pivot-stealth-token-v2'] : (req.headers['x-pivot-stealth-token'] || req.headers['x-pivot-stealth-signature']);

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

    let authority = '';
    if (version === '2') {
        authority = String(req.headers.host || '').trim().toLowerCase();
        if (!authority || /[\s/@?#,]/.test(authority)) return false;
    } else if (version !== '1' || ['false', '0', 'off'].includes(String(process.env.PIVOT_STEALTH_ALLOW_LEGACY || 'true').trim().toLowerCase())) {
        return false;
    }
    const expected = generateStealthSignature(timeNum, getStealthSecret(), authority);

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
        await setAppSettingAsync(STEALTH_SETTING_SECRET_KEY, encryptSecret(newSecret, SECRET_CONTEXT), { updatedBy: userId });
        cachedSecret = newSecret;
    } else if (typeof secret === 'string' && secret.trim().length >= 16) {
        const nextSecret = secret.trim();
        await setAppSettingAsync(STEALTH_SETTING_SECRET_KEY, encryptSecret(nextSecret, SECRET_CONTEXT), { updatedBy: userId });
        cachedSecret = nextSecret;
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
