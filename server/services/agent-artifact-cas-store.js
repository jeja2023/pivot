/**
 * server/services/agent-artifact-cas-store.js
 * 二进制产物 CAS 的文件系统层（只管字节，不碰数据库与授权）
 *
 * 落地方案 v1.2 §7.1、§2.3-C8、阶段 2.2：
 * 1. 复用 agent-blob-store.js 的目录约定、sha256 命名与 0700/0600 权限模式，
 *    但不复用它的 JSON 序列化与「64KB 以下不落盘」逻辑 —— 那会让 IR 不可恢复（R13）；
 * 2. 布局固定为 <root>/<租户 id>/<摘要前 2 位>/<摘要>，同租户同内容天然只存一份；
 * 3. storage_key 只保存相对 root 的正斜杠路径，不含盘符也不对客户端暴露；
 *    任何来自数据库的 storage_key 都要重新校验落点仍在 root 之内，
 *    元数据被污染时按越权处理而不是照着写/读（fail-closed）；
 * 4. 落盘一律「先写临时文件再原子改名」，进程中断不会留下半截可见对象。
 */
const crypto = require('crypto');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

/** 目录 0700、文件 0600：与 agent-blob-store.js 保持同一套权限模式。 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const TEMP_DIR_NAME = '.tmp-write';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

let tempSequence = 0;

/** 构造带 HTTP 状态码的中文错误，路由层可直接透出状态码与错误码。 */
function casError(message, status = 400, code = 'ARTIFACT_CAS_ERROR') {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    return error;
}

/**
 * CAS 存储根目录。
 * 默认沿用 DATA_DIR 约定，另给独立环境变量以便把大体积产物放到单独卷上。
 */
function casRoot() {
    return path.resolve(process.env.PIVOT_ARTIFACT_CAS_DIR
        || path.join(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'agent-artifact-objects'));
}

/** 租户目录段：只接受正整数，避免租户标识被拿来做路径穿越。 */
function tenantSegment(tenantId) {
    const parsed = Number.parseInt(tenantId, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw casError('产物对象缺少有效的租户标识。', 400, 'ARTIFACT_CAS_TENANT_INVALID');
    }
    return String(parsed);
}

/** 摘要必须是 64 位小写十六进制，非法摘要说明上游算错了，直接拒绝。 */
function assertDigest(digest) {
    const text = String(digest || '').toLowerCase();
    if (!DIGEST_PATTERN.test(text)) {
        throw casError('产物对象内容摘要格式非法。', 500, 'ARTIFACT_CAS_DIGEST_INVALID');
    }
    return text;
}

/** 相对 root 的存储键，跨平台统一用正斜杠。 */
function buildStorageKey(tenantId, digest) {
    const safeDigest = assertDigest(digest);
    return `${tenantSegment(tenantId)}/${safeDigest.slice(0, 2)}/${safeDigest}`;
}

/** 把 storage_key 还原成绝对路径，并强制落点仍在存储根目录之内。 */
function resolveStoragePath(storageKey) {
    const key = String(storageKey || '').trim();
    if (!key) throw casError('产物对象的存储位置为空。', 410, 'ARTIFACT_CAS_STORAGE_EMPTY');
    if (key.includes('\0')) throw casError('产物对象的存储位置非法。', 500, 'ARTIFACT_CAS_STORAGE_INVALID');
    const root = casRoot();
    const resolved = path.resolve(root, key);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (!resolved.startsWith(prefix)) {
        throw casError('产物对象的存储位置越出存储根目录，已拒绝访问。', 500, 'ARTIFACT_CAS_STORAGE_ESCAPE');
    }
    return resolved;
}

async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
}

async function statQuiet(filePath) {
    try {
        return await fs.stat(filePath);
    } catch (_) {
        return null;
    }
}

/** 查询对象文件是否存在及其字节数：用于落盘前去重，以及「元数据在、文件丢」的自愈判断。 */
async function statStorageFile(storageKey) {
    const stat = await statQuiet(resolveStoragePath(storageKey));
    const exists = Boolean(stat && stat.isFile());
    return { exists, size: exists ? stat.size : 0 };
}

/**
 * 临时文件名只用进程号、毫秒时间与自增序号。
 * 不引入随机源，渲染产物才能确定复现（§10.2 幂等性指标）。
 */
function tempFilePath() {
    tempSequence += 1;
    return path.join(casRoot(), TEMP_DIR_NAME, `${process.pid}-${Date.now()}-${tempSequence}.part`);
}

async function removeQuiet(filePath) {
    try {
        await fs.unlink(filePath);
        return true;
    } catch (_) {
        return false;
    }
}

/** 删除临时文件；不存在也不算失败。 */
async function removeTempFile(tempPath) {
    if (!tempPath) return false;
    return await removeQuiet(tempPath);
}

/** 删除对象文件；storage_key 已置空（过期回收）或文件缺失都不算失败。 */
async function removeStorageFile(storageKey) {
    const key = String(storageKey || '').trim();
    if (!key) return false;
    return await removeQuiet(resolveStoragePath(key));
}

/** 整块内容先写临时文件，成功后由 promoteTempToStorage 原子改名。 */
async function writeBufferToTemp(buffer) {
    const tempPath = tempFilePath();
    await ensureDir(path.dirname(tempPath));
    await fs.writeFile(tempPath, buffer, { mode: FILE_MODE, flag: 'wx' });
    return tempPath;
}

/**
 * 边写临时文件边算 sha256 与字节数；超过上限立即中止并删除临时文件。
 * 上限判定放在管道内部，超限时不会先把整份内容写满磁盘再报错（R9）。
 */
async function writeStreamToTemp(source, maxBytes) {
    const limit = Number(maxBytes);
    if (!Number.isFinite(limit) || limit <= 0) {
        throw casError('产物对象大小上限配置无效。', 500, 'ARTIFACT_CAS_LIMIT_INVALID');
    }
    const tempPath = tempFilePath();
    await ensureDir(path.dirname(tempPath));
    const hash = crypto.createHash('sha256');
    let byteSize = 0;
    const meter = new Transform({
        transform(chunk, _encoding, callback) {
            const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            byteSize += piece.length;
            if (byteSize > limit) {
                callback(casError(`产物对象超过单文件大小上限 ${limit} 字节，已中止写入。`, 413, 'ARTIFACT_CAS_TOO_LARGE'));
                return;
            }
            hash.update(piece);
            callback(null, piece);
        }
    });
    try {
        await pipeline(source, meter, fsSync.createWriteStream(tempPath, { mode: FILE_MODE, flags: 'wx' }));
    } catch (error) {
        await removeQuiet(tempPath);
        if (error && error.status) throw error;
        throw casError(`产物对象流式写入失败：${error?.message || '未知原因'}`, 500, 'ARTIFACT_CAS_WRITE_FAILED');
    }
    return { tempPath, digest: hash.digest('hex'), byteSize };
}

/**
 * 临时文件原子改名到最终位置。
 * 目标已存在说明同摘要内容已落盘：内容寻址下字节必然相同，删掉临时文件即视为成功
 * （Windows 上 rename 覆盖已存在文件会报 EPERM，这里按并发同内容写入处理）。
 */
async function promoteTempToStorage(tempPath, storageKey) {
    const finalPath = resolveStoragePath(storageKey);
    await ensureDir(path.dirname(finalPath));
    try {
        await fs.rename(tempPath, finalPath);
        return finalPath;
    } catch (error) {
        const existing = await statQuiet(finalPath);
        await removeQuiet(tempPath);
        if (existing && existing.isFile()) return finalPath;
        throw casError(`产物对象落盘失败：${error?.message || '未知原因'}`, 500, 'ARTIFACT_CAS_WRITE_FAILED');
    }
}

/** 读取整份对象内容。仅供小对象（如 IR）使用，大对象走 createStorageReadStream。 */
async function readStorageFile(storageKey) {
    const filePath = resolveStoragePath(storageKey);
    try {
        return await fs.readFile(filePath);
    } catch (_) {
        throw casError('产物对象内容已不可用。', 410, 'ARTIFACT_CAS_CONTENT_MISSING');
    }
}

/** 打开对象内容流。调用方必须先完成授权校验。 */
function createStorageReadStream(storageKey) {
    return fsSync.createReadStream(resolveStoragePath(storageKey));
}

module.exports = {
    DIR_MODE,
    FILE_MODE,
    TEMP_DIR_NAME,
    assertDigest,
    buildStorageKey,
    casError,
    casRoot,
    createStorageReadStream,
    promoteTempToStorage,
    readStorageFile,
    removeStorageFile,
    removeTempFile,
    resolveStoragePath,
    statStorageFile,
    tenantSegment,
    writeBufferToTemp,
    writeStreamToTemp
};
