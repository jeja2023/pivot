/**
 * desktop/delivery/output-grants.js
 * 桌面端本机写入目录授权表（落地方案 v1.2 §7.6、§7.7 第 1~2、6~7 条）
 *
 * 与只读授权（local_database、local_report_dir）完全分离：只读授权绝不隐含写入权。
 * 授权粒度是用户在桌面端显式选择的具体子目录；系统根、盘符根、用户主目录本身、
 * Program Files、Windows 等目录一律拒绝。完整目录绝对路径只保存在本机受保护存储中，
 * 服务端仅持有授权 id、末级目录提示、设备绑定与有效期。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertWritableDirectory } = require('./atomic-write');
const { DELIVERY_EXTENSION_BY_FORMAT, LEGACY_DEFAULT_DELIVERY_FORMATS } = require('../../server/services/agent-path-safety');

const GRANT_DIR_NAME = 'agent-delivery';
const GRANT_FILE_NAME = 'output-grants.json';

const WINDOWS_FORBIDDEN_ENV_KEYS = ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'windir', 'SystemRoot'];
const POSIX_FORBIDDEN_ROOTS = [
    '/etc', '/bin', '/sbin', '/usr', '/var', '/boot', '/dev', '/proc', '/sys',
    '/lib', '/lib64', '/root', '/System', '/Library', '/Applications'
];

let injectedDeps = null;
let grantCache = null;

function grantError(message, code = 'DELIVERY_GRANT_INVALID') {
    const error = new Error(message);
    error.code = code;
    error.category = 'permission';
    return error;
}

/** 注入 userData 目录、用户主目录与平台标识；不注入时在 Electron 运行期自动解析。 */
function configureOutputGrants(deps = {}) {
    injectedDeps = {
        userDataDir: deps.userDataDir ? String(deps.userDataDir) : '',
        homeDir: deps.homeDir ? String(deps.homeDir) : '',
        platform: deps.platform ? String(deps.platform) : ''
    };
    grantCache = null;
    return { userDataDir: injectedDeps.userDataDir };
}

function resolveUserDataDir() {
    if (injectedDeps && injectedDeps.userDataDir) return injectedDeps.userDataDir;
    const electron = require('electron');
    const userDataDir = electron.app.getPath('userData');
    if (!userDataDir) throw grantError('无法定位用户数据目录，写入授权表不可用。', 'DELIVERY_GRANT_STORE_UNAVAILABLE');
    return userDataDir;
}

function grantFilePath() {
    return path.join(resolveUserDataDir(), GRANT_DIR_NAME, GRANT_FILE_NAME);
}

function currentPlatform(options = {}) {
    return String(options.platform || (injectedDeps && injectedDeps.platform) || process.platform);
}

function currentHomeDir(options = {}) {
    return String(options.homeDir || (injectedDeps && injectedDeps.homeDir) || os.homedir() || '');
}

function comparablePath(value, platform) {
    const text = path.resolve(String(value || ''));
    return platform === 'win32' ? text.replace(/\+$/, '').toLowerCase() : text.replace(/\/+$/, '');
}

/** 判断 child 是否位于 parent 之内（不含相等）。 */
function isInside(parent, child, platform) {
    const from = comparablePath(parent, platform);
    const to = comparablePath(child, platform);
    if (!from || !to || from === to) return false;
    const relative = path.relative(from, to);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isSamePath(left, right, platform) {
    return Boolean(left) && Boolean(right) && comparablePath(left, platform) === comparablePath(right, platform);
}

function forbiddenSystemDirs(platform, env = process.env) {
    if (platform === 'win32') {
        return WINDOWS_FORBIDDEN_ENV_KEYS
            .map(key => env[key])
            .filter(value => typeof value === 'string' && value.trim())
            .map(value => path.resolve(value));
    }
    return POSIX_FORBIDDEN_ROOTS.filter(item => fs.existsSync(item)).map(item => path.resolve(item));
}

/** 末级目录提示：只上报「父目录/末级目录」，不上报完整绝对路径（§7.6 第 6 步）。 */
function buildPathHint(directory) {
    const resolved = path.resolve(String(directory || ''));
    const base = path.basename(resolved);
    const parent = path.basename(path.dirname(resolved));
    const hint = base && parent ? `${parent}/${base}` : (base || resolved);
    return hint.slice(0, 255);
}

/**
 * 校验用户选择的写入目录是否可授权。
 * 拒绝：不存在或不可写、系统根与盘符根、用户主目录本身及其上级、Program Files、Windows 等系统目录。
 */
function validateOutputDirectory(directory, options = {}) {
    const platform = currentPlatform(options);
    const homeDir = currentHomeDir(options);
    const resolvedInput = assertWritableDirectory(directory);
    let resolved = resolvedInput;
    try {
        resolved = fs.realpathSync(resolvedInput);
    } catch (_) {
        throw grantError('授权目录无法解析真实路径，请重新选择。', 'DELIVERY_GRANT_PATH_UNRESOLVED');
    }
    const parsed = path.parse(resolved);
    if (isSamePath(resolved, parsed.root, platform)) {
        throw grantError('不允许授权磁盘根目录，请选择一个具体的子文件夹。', 'DELIVERY_GRANT_ROOT_DENIED');
    }
    if (homeDir && isSamePath(resolved, homeDir, platform)) {
        throw grantError('不允许授权用户主目录本身，请选择其中一个具体的子文件夹。', 'DELIVERY_GRANT_HOME_DENIED');
    }
    if (homeDir && isInside(resolved, homeDir, platform)) {
        throw grantError('不允许授权包含用户主目录的上级目录，请选择更具体的子文件夹。', 'DELIVERY_GRANT_HOME_PARENT_DENIED');
    }
    const forbidden = forbiddenSystemDirs(platform, options.env || process.env);
    const hit = forbidden.find(item => isSamePath(resolved, item, platform) || isInside(item, resolved, platform));
    if (hit) {
        throw grantError('不允许授权系统目录（如 Program Files、Windows 或系统盘保留目录）。', 'DELIVERY_GRANT_SYSTEM_DENIED');
    }
    return { directory: resolved, pathHint: buildPathHint(resolved) };
}

function readGrantStore() {
    if (grantCache) return grantCache;
    try {
        const parsed = JSON.parse(fs.readFileSync(grantFilePath(), 'utf8'));
        const rawGrants = parsed && typeof parsed.grants === 'object' && parsed.grants ? parsed.grants : {};
        const platform = currentPlatform();
        const seen = new Map();
        const deduped = {};
        let hasDuplicates = false;
        const records = Object.values(rawGrants).sort((a, b) => {
            const timeA = Date.parse(String(a.createdAt || a.expiresAt || 0).replace(' ', 'T')) || 0;
            const timeB = Date.parse(String(b.createdAt || b.expiresAt || 0).replace(' ', 'T')) || 0;
            return timeB - timeA;
        });
        for (const record of records) {
            if (!record || !record.grantId || !record.directory) continue;
            const key = comparablePath(record.directory, platform);
            if (!seen.has(key)) {
                seen.set(key, record.grantId);
                deduped[record.grantId] = record;
            } else {
                hasDuplicates = true;
            }
        }
        grantCache = { version: 1, grants: deduped };
        if (hasDuplicates) {
            try {
                persistGrantStore(grantCache);
            } catch (_) {}
        }
    } catch (_) {
        grantCache = { version: 1, grants: {} };
    }
    return grantCache;
}

/** 授权表原子落盘：同目录临时文件 + fsync + rename。 */
function persistGrantStore(store) {
    const filePath = grantFilePath();
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tempPath = path.join(directory, `.${GRANT_FILE_NAME}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    const fd = fs.openSync(tempPath, 'wx', 0o600);
    try {
        fs.writeSync(fd, JSON.stringify(store, null, 2), 0, 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch (_) {}
    grantCache = store;
    return filePath;
}

function isExpired(grant, nowMs = Date.now()) {
    const expiresAt = Date.parse(String(grant && grant.expiresAt ? grant.expiresAt : '').replace(' ', 'T'));
    if (!Number.isFinite(expiresAt)) return false;
    return expiresAt <= nowMs;
}

function normalizeLocalAllowedFormats(value) {
    const allowed = (Array.isArray(value) ? value : [])
        .map(item => String(item || '').trim().toLowerCase())
        .filter(item => Object.prototype.hasOwnProperty.call(DELIVERY_EXTENSION_BY_FORMAT, item));
    const legacyDefault = allowed.length === LEGACY_DEFAULT_DELIVERY_FORMATS.length
        && LEGACY_DEFAULT_DELIVERY_FORMATS.every(format => allowed.includes(format));
    if (legacyDefault) return Object.keys(DELIVERY_EXTENSION_BY_FORMAT);
    return [...new Set(allowed)];
}

function findLocalGrantByDirectory(directory, options = {}) {
    const targetDir = path.resolve(String(directory || ''));
    const platform = currentPlatform(options);
    const store = readGrantStore();
    const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
    for (const record of Object.values(store.grants)) {
        if (record && record.directory && isSamePath(record.directory, targetDir, platform)) {
            return {
                ...record,
                allowedFormats: normalizeLocalAllowedFormats(record.allowedFormats),
                expired: isExpired(record, nowMs)
            };
        }
    }
    return null;
}

/** 登记服务端签发的授权 id 与本机绝对路径的映射。 */
function saveLocalGrant(grant = {}) {
    const grantId = String(grant.grantId || grant.id || '').trim();
    if (!grantId) throw grantError('写入授权必须包含服务端签发的授权标识。', 'DELIVERY_GRANT_ID_REQUIRED');
    const directory = path.resolve(String(grant.directory || ''));
    if (!String(grant.directory || '').trim()) throw grantError('写入授权必须包含本机目录路径。', 'DELIVERY_GRANT_PATH_REQUIRED');
    const record = {
        grantId,
        deviceId: String(grant.deviceId || ''),
        directory,
        pathHint: String(grant.pathHint || buildPathHint(directory)),
        allowedFormats: normalizeLocalAllowedFormats(grant.allowedFormats),
        expiresAt: String(grant.expiresAt || ''),
        createdAt: String(grant.createdAt || new Date().toISOString())
    };
    const store = readGrantStore();
    const platform = currentPlatform();
    const updatedGrants = {};
    Object.entries(store.grants).forEach(([id, item]) => {
        if (id !== grantId && item && item.directory && isSamePath(item.directory, directory, platform)) {
            return;
        }
        updatedGrants[id] = item;
    });
    updatedGrants[grantId] = record;
    persistGrantStore({ version: 1, grants: updatedGrants });
    return { ...record, allowedFormats: normalizeLocalAllowedFormats(record.allowedFormats) };
}

/** 读取本机授权；不存在或已过期返回 null，交付执行器据此 fail-closed。 */
function getLocalGrant(grantId, nowMs = Date.now()) {
    const key = String(grantId || '').trim();
    if (!key) return null;
    const record = readGrantStore().grants[key];
    if (!record || typeof record !== 'object') return null;
    if (isExpired(record, nowMs)) return null;
    return { ...record, allowedFormats: normalizeLocalAllowedFormats(record.allowedFormats) };
}

function removeLocalGrant(grantId) {
    const key = String(grantId || '').trim();
    const store = readGrantStore();
    if (!key || !store.grants[key]) return false;
    const grants = { ...store.grants };
    delete grants[key];
    persistGrantStore({ version: 1, grants });
    return true;
}

/** 清理已过期授权，返回清理条数（§7.7 第 7 条有效期上限到期需重新确认）。 */
function pruneExpiredGrants(nowMs = Date.now()) {
    const store = readGrantStore();
    const grants = {};
    let removed = 0;
    Object.entries(store.grants).forEach(([key, record]) => {
        if (isExpired(record, nowMs)) {
            removed += 1;
            return;
        }
        grants[key] = record;
    });
    if (removed) persistGrantStore({ version: 1, grants });
    return removed;
}

/**
 * 列出本机授权。默认不返回完整绝对路径：渲染进程加载的是服务端页面，
 * 完整路径只留在主进程与本机存储中（§7.6）。
 */
function listLocalGrants(options = {}) {
    const includeDirectory = options.includeDirectory === true;
    return Object.values(readGrantStore().grants).map(record => ({
        grantId: record.grantId,
        deviceId: record.deviceId,
        pathHint: record.pathHint,
        directoryName: path.basename(String(record.directory || '')),
        allowedFormats: normalizeLocalAllowedFormats(record.allowedFormats),
        expiresAt: record.expiresAt,
        createdAt: record.createdAt,
        expired: isExpired(record),
        ...(includeDirectory ? { directory: record.directory } : {})
    }));
}

/** 清空进程内缓存与注入依赖，仅供校验脚本使用。 */
function resetForTests() {
    injectedDeps = null;
    grantCache = null;
}

module.exports = {
    buildPathHint,
    configureOutputGrants,
    findLocalGrantByDirectory,
    getLocalGrant,
    grantFilePath,
    isInside,
    listLocalGrants,
    normalizeLocalAllowedFormats,
    pruneExpiredGrants,
    removeLocalGrant,
    resetForTests,
    saveLocalGrant,
    validateOutputDirectory
};
