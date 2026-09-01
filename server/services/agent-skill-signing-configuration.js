/**
 * 组织 Skill 签名密钥配置。
 *
 * 私钥只以 AES-GCM 密文保存在 app_settings，绝不返回浏览器、日志或 Skill 文件。
 * 已轮换密钥的公钥会保留在密钥环中，以便继续复验历史发布的不可变签名信封。
 */
const crypto = require('crypto');
const { decryptSecret, encryptSecret, hasSecretEncryptionKey } = require('../security');
const { getBeijingTimestamp } = require('../time');
const { getAppSettingValue, setAppSettingAsync } = require('./app-settings');

const ORGANIZATION_SIGNING_KEYRING_SETTING = 'agent_skill_organization_signing_keyring';
const KEYRING_VERSION = 1;
const MAX_KEYRING_KEYS = 8;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function signingConfigurationError(message, code = 'SKILL_SIGNING_CONFIGURATION_INVALID', status = 422) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

function normalizePem(value) {
    return String(value || '').trim().replace(/\\n/g, '\n');
}

function normalizeKeyId(value) {
    const keyId = String(value || '').trim();
    return KEY_ID_RE.test(keyId) ? keyId : '';
}

function fingerprintPublicKey(publicKey) {
    try {
        const der = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
        return crypto.createHash('sha256').update(der).digest('hex');
    } catch (_) {
        return '';
    }
}

function normalizeKeyPair({ privateKey, publicKey, keyId, createdAt, retiredAt } = {}) {
    const privatePem = normalizePem(privateKey);
    if (!privatePem) throw signingConfigurationError('组织签名私钥不能为空。', 'SKILL_SIGNING_PRIVATE_KEY_REQUIRED');
    if (privatePem.length > 32768 || normalizePem(publicKey).length > 16384) {
        throw signingConfigurationError('组织签名密钥内容超过允许大小。', 'SKILL_SIGNING_KEY_TOO_LARGE', 400);
    }
    let privateObject;
    try {
        privateObject = crypto.createPrivateKey(privatePem);
    } catch (_) {
        throw signingConfigurationError('组织签名私钥格式无效。', 'SKILL_SIGNING_PRIVATE_KEY_INVALID');
    }
    if (privateObject.asymmetricKeyType !== 'rsa') {
        throw signingConfigurationError('组织签名仅支持 RSA 私钥。', 'SKILL_SIGNING_PRIVATE_KEY_ALGORITHM_INVALID');
    }
    const derivedPublicPem = crypto.createPublicKey(privateObject).export({ type: 'spki', format: 'pem' });
    const suppliedPublicPem = normalizePem(publicKey);
    if (suppliedPublicPem && fingerprintPublicKey(suppliedPublicPem) !== fingerprintPublicKey(derivedPublicPem)) {
        throw signingConfigurationError('导入的公钥与私钥不匹配。', 'SKILL_SIGNING_KEYPAIR_MISMATCH');
    }
    const fingerprint = fingerprintPublicKey(derivedPublicPem);
    if (!fingerprint) throw signingConfigurationError('无法计算组织签名公钥指纹。', 'SKILL_SIGNING_PUBLIC_KEY_INVALID');
    const normalizedKeyId = normalizeKeyId(keyId) || `organization-${fingerprint.slice(0, 16)}`;
    return {
        keyId: normalizedKeyId,
        privateKey: privatePem,
        publicKey: derivedPublicPem,
        fingerprint,
        createdAt: String(createdAt || getBeijingTimestamp()),
        retiredAt: retiredAt ? String(retiredAt) : null
    };
}

function emptyKeyring() {
    return { version: KEYRING_VERSION, activeKeyId: '', keys: [], error: '' };
}

function parseManagedKeyring(raw = getAppSettingValue(ORGANIZATION_SIGNING_KEYRING_SETTING)) {
    if (!raw) return emptyKeyring();
    try {
        const decrypted = decryptSecret(raw);
        const parsed = JSON.parse(decrypted);
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.keys)) {
            throw new Error('密钥环格式不正确');
        }
        const keys = [];
        for (const item of parsed.keys.slice(0, MAX_KEYRING_KEYS)) {
            try {
                const normalized = normalizeKeyPair(item);
                normalized.retiredAt = item.retiredAt ? String(item.retiredAt) : null;
                keys.push(normalized);
            } catch (_) {
                throw new Error('密钥环包含无效密钥');
            }
        }
        const activeKeyId = normalizeKeyId(parsed.activeKeyId);
        if (activeKeyId && !keys.some(key => key.keyId === activeKeyId && !key.retiredAt)) {
            throw new Error('活动密钥不存在或已停用');
        }
        return { version: KEYRING_VERSION, activeKeyId, keys, error: '' };
    } catch (error) {
        return { ...emptyKeyring(), error: String(error.message || '组织签名密钥环无法读取') };
    }
}

function getEnvironmentPrivateKey(env = process.env) {
    const encoded = String(env.AGENT_SKILL_ORGANIZATION_PRIVATE_KEY_BASE64 || '').trim();
    if (encoded) {
        try { return normalizePem(Buffer.from(encoded, 'base64').toString('utf8')); } catch (_) { return ''; }
    }
    return normalizePem(env.AGENT_SKILL_ORGANIZATION_PRIVATE_KEY);
}

function hasEnvironmentPrivateKey(env = process.env) {
    return Boolean(String(env.AGENT_SKILL_ORGANIZATION_PRIVATE_KEY_BASE64 || env.AGENT_SKILL_ORGANIZATION_PRIVATE_KEY || '').trim());
}

function getEnvironmentSigningKey(env = process.env) {
    const privateKey = getEnvironmentPrivateKey(env);
    if (!privateKey) return null;
    try {
        return {
            ...normalizeKeyPair({
                privateKey,
                publicKey: env.AGENT_SKILL_PUBLIC_KEY,
                keyId: env.AGENT_SKILL_ORGANIZATION_KEY_ID || 'organization-default'
            }),
            source: 'environment'
        };
    } catch (_) {
        return null;
    }
}

function getManagedActiveSigningKey() {
    const keyring = parseManagedKeyring();
    if (keyring.error || !keyring.activeKeyId) return null;
    const key = keyring.keys.find(item => item.keyId === keyring.activeKeyId && !item.retiredAt);
    return key ? { ...key, source: 'managed' } : null;
}

function getOrganizationSigningKey(env = process.env) {
    // 环境中出现私钥即代表部署端接管；格式错误时必须 fail-closed，不能静默回退到数据库密钥。
    if (hasEnvironmentPrivateKey(env)) return getEnvironmentSigningKey(env);
    return getManagedActiveSigningKey();
}

function getOrganizationSigningPublicKey(keyId, env = process.env) {
    const normalizedKeyId = normalizeKeyId(keyId);
    const environment = getEnvironmentSigningKey(env);
    if (environment && (!normalizedKeyId || environment.keyId === normalizedKeyId)) return environment.publicKey;
    const keyring = parseManagedKeyring();
    const managed = keyring.keys.find(item => item.keyId === normalizedKeyId);
    if (managed) return managed.publicKey;
    if (!normalizedKeyId && keyring.activeKeyId) {
        return keyring.keys.find(item => item.keyId === keyring.activeKeyId)?.publicKey || '';
    }
    return '';
}

function serializeKeyring(keyring) {
    return JSON.stringify({
        version: KEYRING_VERSION,
        activeKeyId: keyring.activeKeyId || '',
        keys: (keyring.keys || []).map(key => ({
            keyId: key.keyId,
            privateKey: key.privateKey,
            publicKey: key.publicKey,
            createdAt: key.createdAt,
            retiredAt: key.retiredAt || null
        }))
    });
}

async function saveManagedKeyring(keyring, userId) {
    if (!hasSecretEncryptionKey()) {
        throw signingConfigurationError('未配置 DATA_ENCRYPTION_KEY 或 JWT_SECRET，不能安全保存组织签名私钥。', 'SKILL_SIGNING_ENCRYPTION_KEY_MISSING', 409);
    }
    await setAppSettingAsync(
        ORGANIZATION_SIGNING_KEYRING_SETTING,
        encryptSecret(serializeKeyring(keyring)),
        { updatedBy: userId || null }
    );
}

function ensureManagedConfigurationAvailable() {
    if (hasEnvironmentPrivateKey()) {
        throw signingConfigurationError('组织签名由服务器环境变量接管，不能在页面中覆盖。', 'SKILL_SIGNING_ENVIRONMENT_MANAGED', 409);
    }
    const keyring = parseManagedKeyring();
    if (keyring.error) {
        throw signingConfigurationError(`组织签名密钥环无法读取：${keyring.error}`, 'SKILL_SIGNING_KEYRING_UNREADABLE', 409);
    }
    return keyring;
}

function publicKeyMetadata(key, activeKeyId) {
    return {
        keyId: key.keyId,
        fingerprint: key.fingerprint || fingerprintPublicKey(key.publicKey),
        createdAt: key.createdAt || null,
        retiredAt: key.retiredAt || null,
        status: key.keyId === activeKeyId && !key.retiredAt ? 'active' : (key.retiredAt ? 'retired' : 'standby')
    };
}

function getOrganizationSigningConfigStatus(env = process.env) {
    const environment = getEnvironmentSigningKey(env);
    const keyring = parseManagedKeyring();
    const environmentManaged = hasEnvironmentPrivateKey(env);
    const active = environmentManaged
        ? environment
        : (keyring.activeKeyId ? keyring.keys.find(key => key.keyId === keyring.activeKeyId) : null);
    return {
        configured: Boolean(active?.privateKey),
        source: environmentManaged ? 'environment' : (active ? 'managed' : 'none'),
        environmentManaged,
        activeKeyId: active?.keyId || '',
        fingerprint: active?.fingerprint || '',
        publicKeyConfigured: Boolean(active?.publicKey || normalizePem(env.AGENT_SKILL_PUBLIC_KEY)),
        privateKeyConfigured: Boolean(active?.privateKey),
        encryptionReady: hasSecretEncryptionKey(),
        keyringError: keyring.error || (environmentManaged && !environment ? '环境变量中的组织签名密钥无效或与公钥不匹配' : ''),
        keys: keyring.keys.map(key => publicKeyMetadata(key, keyring.activeKeyId)),
        environmentPublicKeyConfigured: Boolean(normalizePem(env.AGENT_SKILL_PUBLIC_KEY))
    };
}

async function generateManagedOrganizationSigningKey({ keyId = '', userId } = {}) {
    const keyring = ensureManagedConfigurationAvailable();
    const pair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 3072,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const next = normalizeKeyPair({ privateKey: pair.privateKey, publicKey: pair.publicKey, keyId });
    if (keyring.keys.some(key => key.keyId === next.keyId)) {
        throw signingConfigurationError('组织签名密钥标识已存在，请使用其他标识。', 'SKILL_SIGNING_KEY_ID_CONFLICT', 409);
    }
    const now = getBeijingTimestamp();
    keyring.keys = keyring.keys.map(key => key.keyId === keyring.activeKeyId ? { ...key, retiredAt: now } : key);
    keyring.keys.push(next);
    if (keyring.keys.length > MAX_KEYRING_KEYS) {
        throw signingConfigurationError(`组织签名密钥环最多保留 ${MAX_KEYRING_KEYS} 个密钥，请先处理不再需要的历史密钥。`, 'SKILL_SIGNING_KEYRING_LIMIT', 409);
    }
    keyring.activeKeyId = next.keyId;
    await saveManagedKeyring(keyring, userId);
    return getOrganizationSigningConfigStatus();
}

async function importManagedOrganizationSigningKey({ privateKey, publicKey, keyId = '', activate = true, userId } = {}) {
    const keyring = ensureManagedConfigurationAvailable();
    const next = normalizeKeyPair({ privateKey, publicKey, keyId });
    if (keyring.keys.some(key => key.keyId === next.keyId)) {
        throw signingConfigurationError('组织签名密钥标识已存在，请使用其他标识。', 'SKILL_SIGNING_KEY_ID_CONFLICT', 409);
    }
    if (keyring.keys.some(key => key.fingerprint === next.fingerprint)) {
        throw signingConfigurationError('该组织签名密钥已存在。', 'SKILL_SIGNING_KEY_ALREADY_EXISTS', 409);
    }
    if (keyring.keys.length >= MAX_KEYRING_KEYS) {
        throw signingConfigurationError(`组织签名密钥环最多保留 ${MAX_KEYRING_KEYS} 个密钥。`, 'SKILL_SIGNING_KEYRING_LIMIT', 409);
    }
    if (activate !== false) {
        const now = getBeijingTimestamp();
        keyring.keys = keyring.keys.map(key => key.keyId === keyring.activeKeyId ? { ...key, retiredAt: now } : key);
        keyring.activeKeyId = next.keyId;
    }
    keyring.keys.push(next);
    await saveManagedKeyring(keyring, userId);
    return getOrganizationSigningConfigStatus();
}

async function activateManagedOrganizationSigningKey({ keyId, userId } = {}) {
    const keyring = ensureManagedConfigurationAvailable();
    const normalizedKeyId = normalizeKeyId(keyId);
    const target = keyring.keys.find(key => key.keyId === normalizedKeyId);
    if (!target) throw signingConfigurationError('组织签名密钥不存在。', 'SKILL_SIGNING_KEY_NOT_FOUND', 404);
    const now = getBeijingTimestamp();
    keyring.keys = keyring.keys.map(key => {
        if (key.keyId === target.keyId) return { ...key, retiredAt: null };
        if (key.keyId === keyring.activeKeyId) return { ...key, retiredAt: now };
        return key;
    });
    keyring.activeKeyId = target.keyId;
    await saveManagedKeyring(keyring, userId);
    return getOrganizationSigningConfigStatus();
}

async function disableManagedOrganizationSigning({ userId } = {}) {
    const keyring = ensureManagedConfigurationAvailable();
    if (keyring.activeKeyId) {
        const now = getBeijingTimestamp();
        keyring.keys = keyring.keys.map(key => key.keyId === keyring.activeKeyId ? { ...key, retiredAt: now } : key);
    }
    keyring.activeKeyId = '';
    await saveManagedKeyring(keyring, userId);
    return getOrganizationSigningConfigStatus();
}

module.exports = {
    KEYRING_VERSION,
    MAX_KEYRING_KEYS,
    ORGANIZATION_SIGNING_KEYRING_SETTING,
    activateManagedOrganizationSigningKey,
    disableManagedOrganizationSigning,
    fingerprintPublicKey,
    generateManagedOrganizationSigningKey,
    getEnvironmentSigningKey,
    hasEnvironmentPrivateKey,
    getManagedActiveSigningKey,
    getOrganizationSigningConfigStatus,
    getOrganizationSigningKey,
    getOrganizationSigningPublicKey,
    importManagedOrganizationSigningKey,
    normalizeKeyId,
    normalizePem,
    parseManagedKeyring,
    signingConfigurationError
};
