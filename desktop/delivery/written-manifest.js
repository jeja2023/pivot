/**
 * desktop/delivery/written-manifest.js
 * 桌面端本地已写清单（落地方案 v1.2 §7.6 第 7 步、§7.4 第 5 条、§10.3 幂等性）
 *
 * 幂等由「服务端唯一键 + 桌面端已写清单」双侧保证：清单以交付意图的幂等键为主键，
 * 记录目标绝对路径、内容摘要、字节数与写入时间。重复领取同一意图时直接回执，不再落盘。
 * 完整绝对路径只保存在本机清单，回执与控制面只上报文件名与末级目录提示。
 *
 * 清单以 JSON 原子落盘（同目录临时文件 + fsync + rename），userData 目录可注入，便于纯 node 校验。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_DIR_NAME = 'agent-delivery';
const MANIFEST_FILE_NAME = 'written-manifest.json';

let injectedDeps = null;
let manifestCache = null;

function manifestError(message, code = 'DELIVERY_MANIFEST_UNAVAILABLE') {
    const error = new Error(message);
    error.code = code;
    return error;
}

/** 注入 userData 目录；不注入时在 Electron 运行期自动解析。 */
function configureWrittenManifest(deps = {}) {
    injectedDeps = { userDataDir: deps.userDataDir ? String(deps.userDataDir) : '' };
    manifestCache = null;
    return { userDataDir: injectedDeps.userDataDir };
}

function resolveUserDataDir() {
    if (injectedDeps && injectedDeps.userDataDir) return injectedDeps.userDataDir;
    const electron = require('electron');
    const userDataDir = electron.app.getPath('userData');
    if (!userDataDir) throw manifestError('无法定位用户数据目录，已写清单不可用。');
    return userDataDir;
}

function manifestFilePath() {
    return path.join(resolveUserDataDir(), MANIFEST_DIR_NAME, MANIFEST_FILE_NAME);
}

function normalizeKey(value) {
    return String(value || '').trim();
}

function readManifest() {
    if (manifestCache) return manifestCache;
    const filePath = manifestFilePath();
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const entries = parsed && typeof parsed.entries === 'object' && parsed.entries ? parsed.entries : {};
        manifestCache = { version: 1, entries };
    } catch (_) {
        manifestCache = { version: 1, entries: {} };
    }
    return manifestCache;
}

/** 原子落盘：同目录临时文件写入后 fsync，再 rename 覆盖正式清单。 */
function persistManifest(manifest) {
    const filePath = manifestFilePath();
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tempPath = path.join(directory, `.${MANIFEST_FILE_NAME}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    const fd = fs.openSync(tempPath, 'wx', 0o600);
    try {
        fs.writeSync(fd, JSON.stringify(manifest, null, 2), 0, 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch (_) {}
    manifestCache = manifest;
    return filePath;
}

/** 读取一条已写记录；不存在返回 null。 */
function getWritten(key) {
    const safeKey = normalizeKey(key);
    if (!safeKey) return null;
    const entry = readManifest().entries[safeKey];
    return entry && typeof entry === 'object' ? entry : null;
}

/** 幂等判定：清单命中即表示本机已完成该意图的落盘，不得重复写文件。 */
function hasWritten(key) {
    return getWritten(key) !== null;
}

/**
 * 追加一条已写记录。
 * key 取交付意图的幂等键（服务端生成），targetPath 为本机完整绝对路径，仅保存在本地。
 */
function recordWritten(entry = {}) {
    const key = normalizeKey(entry.key);
    if (!key) throw manifestError('已写清单必须提供幂等键。', 'DELIVERY_MANIFEST_KEY_REQUIRED');
    const targetPath = String(entry.targetPath || '').trim();
    if (!targetPath) throw manifestError('已写清单必须提供落盘路径。', 'DELIVERY_MANIFEST_PATH_REQUIRED');
    const manifest = readManifest();
    const record = {
        key,
        targetPath,
        filename: String(entry.filename || path.basename(targetPath)),
        pathHint: String(entry.pathHint || ''),
        digest: String(entry.digest || '').toLowerCase(),
        bytes: Number(entry.bytes) || 0,
        intentId: entry.intentId === undefined || entry.intentId === null ? '' : String(entry.intentId),
        renditionId: entry.renditionId === undefined || entry.renditionId === null ? '' : String(entry.renditionId),
        overwritten: entry.overwritten === true,
        writtenAt: String(entry.writtenAt || new Date().toISOString())
    };
    const next = { version: 1, entries: { ...manifest.entries, [key]: record } };
    persistManifest(next);
    return record;
}

/** 清理超过指定天数的历史记录，返回清理条数。 */
function pruneOlderThan(days) {
    const keepDays = Math.max(Number(days) || 0, 0);
    if (!keepDays) return 0;
    const threshold = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    const manifest = readManifest();
    const entries = {};
    let removed = 0;
    Object.entries(manifest.entries).forEach(([key, record]) => {
        const writtenAt = Date.parse(String(record && record.writtenAt ? record.writtenAt : ''));
        if (Number.isFinite(writtenAt) && writtenAt < threshold) {
            removed += 1;
            return;
        }
        entries[key] = record;
    });
    if (removed) persistManifest({ version: 1, entries });
    return removed;
}

/** 统计指定时间点之后已写入的字节数，供桌面端单日配额限制使用（§7.7 第 5 条）。 */
function sumBytesWrittenSince(sinceMs) {
    const since = Number(sinceMs) || 0;
    return Object.values(readManifest().entries).reduce((total, record) => {
        const writtenAt = Date.parse(String(record && record.writtenAt ? record.writtenAt : ''));
        if (!Number.isFinite(writtenAt) || writtenAt < since) return total;
        return total + (Number(record && record.bytes) || 0);
    }, 0);
}

function listWritten(limit = 50) {
    const max = Math.max(Math.min(Number(limit) || 50, 500), 1);
    return Object.values(readManifest().entries)
        .sort((a, b) => String(b.writtenAt || '').localeCompare(String(a.writtenAt || '')))
        .slice(0, max)
        .map(record => ({
            key: record.key,
            filename: record.filename,
            pathHint: record.pathHint,
            digest: record.digest,
            bytes: record.bytes,
            overwritten: record.overwritten === true,
            writtenAt: record.writtenAt
        }));
}

/** 清空进程内缓存与注入依赖，仅供校验脚本使用。 */
function resetForTests() {
    injectedDeps = null;
    manifestCache = null;
}

module.exports = {
    configureWrittenManifest,
    getWritten,
    hasWritten,
    listWritten,
    manifestFilePath,
    pruneOlderThan,
    recordWritten,
    resetForTests,
    sumBytesWrittenSince
};
