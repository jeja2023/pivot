/**
 * desktop/delivery/device-identity.js
 * 桌面端交付设备身份（落地方案 v1.2 §7.6 第 0 步、§7.7、阶段 3.2）
 *
 * 设计要点：
 * 1. 设备密钥对在本机生成，优先 Ed25519；私钥必须先经 Electron safeStorage 加密再落盘，
 *    safeStorage 不可用时直接拒绝启用交付能力，绝不退化为明文保存私钥；
 * 2. 身份文件位于 app.getPath('userData') 下，目录权限 0o700、文件权限 0o600；
 * 3. 服务端只保存公钥与设备状态，签名载荷按「用途:挑战值:设备标识」冒号拼接，
 *    与 server/services/agent-local-devices.js 的校验实现一一对应；
 * 4. safeStorage、userData 目录均为可注入依赖，便于在纯 node 环境下做逻辑校验。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IDENTITY_DIR_NAME = 'agent-delivery';
const IDENTITY_FILE_NAME = 'device-identity.json';
const DEVICE_ID_PREFIX = 'desktop-';

let injectedDeps = null;
let identityCache = null;

function identityError(message, code = 'DELIVERY_IDENTITY_UNAVAILABLE') {
    const error = new Error(message);
    error.code = code;
    error.category = 'permission';
    return error;
}

/** 注入 safeStorage 与 userData 目录；不注入时在 Electron 运行期自动解析。 */
function configureDeviceIdentity(deps = {}) {
    injectedDeps = {
        safeStorage: deps.safeStorage || null,
        userDataDir: deps.userDataDir ? String(deps.userDataDir) : ''
    };
    identityCache = null;
    return { userDataDir: injectedDeps.userDataDir };
}

function resolveDeps() {
    if (injectedDeps && injectedDeps.safeStorage && injectedDeps.userDataDir) return injectedDeps;
    // 未注入依赖时只在 Electron 主进程内可用；纯 node 下应先调用 configureDeviceIdentity。
    const electron = require('electron');
    const safeStorage = (injectedDeps && injectedDeps.safeStorage) || electron.safeStorage;
    const userDataDir = (injectedDeps && injectedDeps.userDataDir) || electron.app.getPath('userData');
    if (!safeStorage || !userDataDir) throw identityError('无法定位桌面端安全存储与用户数据目录，交付能力不可用。');
    return { safeStorage, userDataDir };
}

function identityDir(userDataDir) {
    return path.join(userDataDir, IDENTITY_DIR_NAME);
}

function identityFilePath(userDataDir) {
    return path.join(identityDir(userDataDir), IDENTITY_FILE_NAME);
}

/** 保证目录存在且仅当前用户可访问（Windows 下 chmod 为空操作，不影响流程）。 */
function ensurePrivateDir(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(directory, 0o700); } catch (_) {}
}

function assertEncryptionAvailable(safeStorage) {
    const available = typeof safeStorage.isEncryptionAvailable === 'function'
        ? safeStorage.isEncryptionAvailable() === true
        : false;
    if (!available) {
        throw identityError(
            '当前系统未提供可用的凭据加密服务（safeStorage 不可用），受控交付已停用：设备私钥不允许明文保存。',
            'DELIVERY_SAFE_STORAGE_UNAVAILABLE'
        );
    }
    if (typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') {
        throw identityError('安全存储接口不完整，无法加密保存设备私钥，受控交付已停用。', 'DELIVERY_SAFE_STORAGE_UNAVAILABLE');
    }
}

/** 生成设备密钥对：优先 Ed25519，系统不支持时退回 RSA-3072（服务端两者都能验签）。 */
function generateDeviceKeyPair() {
    try {
        const pair = crypto.generateKeyPairSync('ed25519');
        return { keyType: 'ed25519', ...pair };
    } catch (_) {
        const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
        return { keyType: 'rsa', ...pair };
    }
}

function exportPublicKeyPem(publicKey) {
    return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

function exportPrivateKeyPem(privateKey) {
    return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function publicKeyFingerprint(publicKeyPem) {
    const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(der).digest('hex');
}

function readIdentityFile(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return null;
        if (!parsed.deviceId || !parsed.publicKeyPem || !parsed.privateKeyCipher) return null;
        return parsed;
    } catch (_) {
        return null;
    }
}

/** 身份文件原子落盘：先写同目录临时文件并 fsync，再 rename 覆盖，避免半截文件。 */
function writeIdentityFile(filePath, payload) {
    ensurePrivateDir(path.dirname(filePath));
    const tempPath = path.join(path.dirname(filePath), `.${IDENTITY_FILE_NAME}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    const fd = fs.openSync(tempPath, 'wx', 0o600);
    try {
        fs.writeSync(fd, JSON.stringify(payload, null, 2), 0, 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch (_) {}
}

function loadIdentity() {
    if (identityCache) return identityCache;
    const { safeStorage, userDataDir } = resolveDeps();
    assertEncryptionAvailable(safeStorage);
    const filePath = identityFilePath(userDataDir);
    const stored = readIdentityFile(filePath);
    if (stored) {
        let privateKeyPem = '';
        try {
            privateKeyPem = safeStorage.decryptString(Buffer.from(String(stored.privateKeyCipher), 'base64'));
        } catch (_) {
            throw identityError('设备私钥解密失败，可能是系统凭据已变更；请撤销该设备后重新配对。', 'DELIVERY_IDENTITY_CORRUPTED');
        }
        identityCache = {
            deviceId: String(stored.deviceId),
            keyType: String(stored.keyType || 'ed25519'),
            publicKeyPem: String(stored.publicKeyPem),
            privateKey: crypto.createPrivateKey(privateKeyPem),
            fingerprint: publicKeyFingerprint(String(stored.publicKeyPem)),
            createdAt: String(stored.createdAt || '')
        };
        return identityCache;
    }
    const { keyType, publicKey, privateKey } = generateDeviceKeyPair();
    const publicKeyPem = exportPublicKeyPem(publicKey);
    const deviceId = DEVICE_ID_PREFIX + crypto.randomBytes(12).toString('hex');
    const createdAt = new Date().toISOString();
    writeIdentityFile(filePath, {
        version: 1,
        deviceId,
        keyType,
        publicKeyPem,
        privateKeyCipher: safeStorage.encryptString(exportPrivateKeyPem(privateKey)).toString('base64'),
        createdAt
    });
    identityCache = { deviceId, keyType, publicKeyPem, privateKey, fingerprint: publicKeyFingerprint(publicKeyPem), createdAt };
    return identityCache;
}

/** 设备标识：本机生成并持久化，格式满足服务端 [A-Za-z0-9._:-]{8,64} 约束。 */
function getDeviceId() {
    return loadIdentity().deviceId;
}

function getPublicKeyPem() {
    return loadIdentity().publicKeyPem;
}

function getKeyFingerprint() {
    return loadIdentity().fingerprint;
}

/**
 * 用设备私钥签名指定载荷，返回 base64。
 * Ed25519 走一步式签名，RSA/EC 走 sha256 摘要签名，与服务端验签分支一致。
 */
function signPayload(payload) {
    const identity = loadIdentity();
    const data = Buffer.from(String(payload), 'utf8');
    const algorithm = identity.privateKey.asymmetricKeyType === 'ed25519' || identity.privateKey.asymmetricKeyType === 'ed448'
        ? null
        : 'sha256';
    return crypto.sign(algorithm, data, identity.privateKey).toString('base64');
}

/** 交付能力可用性自检：不抛错，供状态查询与界面提示使用。 */
function getIdentityStatus() {
    try {
        const identity = loadIdentity();
        return {
            available: true,
            deviceId: identity.deviceId,
            keyType: identity.keyType,
            keyFingerprint: identity.fingerprint,
            createdAt: identity.createdAt,
            reason: ''
        };
    } catch (error) {
        return {
            available: false,
            deviceId: '',
            keyType: '',
            keyFingerprint: '',
            createdAt: '',
            reason: error && error.message ? error.message : '设备身份不可用。',
            code: error && error.code ? error.code : 'DELIVERY_IDENTITY_UNAVAILABLE'
        };
    }
}

/** 清空进程内缓存与注入依赖，仅供校验脚本使用。 */
function resetForTests() {
    injectedDeps = null;
    identityCache = null;
}

module.exports = {
    configureDeviceIdentity,
    getDeviceId,
    getIdentityStatus,
    getKeyFingerprint,
    getPublicKeyPem,
    identityFilePath,
    resetForTests,
    signPayload
};
