/**
 * desktop/delivery/atomic-write.js
 * 交付文件原子写入（落地方案 v1.2 §7.6 写入流程第 2~5 步、§7.7 第 3~4 条、§10.3 原子性）
 *
 * 流程：边写同目录临时文件边算 sha256 → 与期望摘要比对（不一致删除临时文件并判失败且不重试）
 * → fsync 临时文件 → rename 到目标路径（同分区，保证原子替换）→ 刷新目标目录项。
 * 命名冲突默认不覆盖，自动追加「名称 (2).docx」形式的递增后缀；只有显式允许覆盖时才覆盖。
 * 路径安全全部复用 server/services/agent-path-safety.js，不在桌面端另写一套。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    assertRealPathInside,
    resolveNonConflictingPath,
    resolveWithinRoot
} = require('../../server/services/agent-path-safety');

function writeError(message, code = 'DELIVERY_WRITE_FAILED', retryable = true) {
    const error = new Error(message);
    error.code = code;
    error.retryable = retryable;
    return error;
}

/** 目标目录必须已存在且确为目录：授权目录被移动或删除时立即拒绝，不隐式创建。 */
function assertWritableDirectory(directory) {
    const resolved = path.resolve(String(directory || ''));
    if (!resolved || !String(directory || '').trim()) throw writeError('缺少写入目录。', 'DELIVERY_DIR_REQUIRED', false);
    let stats;
    try {
        stats = fs.statSync(resolved);
    } catch (_) {
        throw writeError('授权目录不存在或已被移动，请重新授权后再试。', 'DELIVERY_DIR_MISSING', false);
    }
    if (!stats.isDirectory()) throw writeError('授权目标不是目录，请重新选择一个真实文件夹。', 'DELIVERY_DIR_INVALID', false);
    try {
        fs.accessSync(resolved, fs.constants.W_OK);
    } catch (_) {
        throw writeError('当前系统权限不足，无法写入授权目录。', 'DELIVERY_DIR_NOT_WRITABLE', false);
    }
    return resolved;
}

/**
 * 把不同形态的字节来源统一成异步可迭代对象：Buffer、字符串、异步可迭代流、
 * Web ReadableStream 与事件式流（Electron IncomingMessage）都支持。
 */
function toAsyncIterable(source) {
    if (source === null || source === undefined) throw writeError('缺少可读取的字节流。', 'DELIVERY_SOURCE_REQUIRED', false);
    if (Buffer.isBuffer(source)) return [source];
    if (typeof source === 'string') return [Buffer.from(source, 'utf8')];
    if (source instanceof Uint8Array) return [Buffer.from(source)];
    if (typeof source[Symbol.asyncIterator] === 'function') return source;
    if (typeof source.getReader === 'function') return webStreamToAsyncIterable(source);
    if (typeof source.on === 'function') return eventStreamToAsyncIterable(source);
    throw writeError('不支持的字节流类型。', 'DELIVERY_SOURCE_UNSUPPORTED', false);
}

function webStreamToAsyncIterable(stream) {
    return {
        async *[Symbol.asyncIterator]() {
            const reader = stream.getReader();
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) return;
                    if (value) yield Buffer.from(value);
                }
            } finally {
                try { reader.releaseLock(); } catch (_) {}
            }
        }
    };
}

/**
 * 事件式流转异步可迭代：缓存待消费分片并在到达时唤醒消费者。
 * 单次写入体积在调用方受上限约束，因此缓存量可控。
 */
function eventStreamToAsyncIterable(stream) {
    const pending = [];
    let finished = false;
    let failure = null;
    let wake = null;
    const notify = () => {
        const resolve = wake;
        wake = null;
        if (resolve) resolve();
    };
    stream.on('data', (chunk) => { pending.push(Buffer.from(chunk)); notify(); });
    stream.on('end', () => { finished = true; notify(); });
    stream.on('error', (error) => { failure = error; finished = true; notify(); });
    stream.on('aborted', () => {
        failure = failure || writeError('下载连接已中断。', 'DELIVERY_DOWNLOAD_ABORTED');
        finished = true;
        notify();
    });
    return {
        async *[Symbol.asyncIterator]() {
            for (;;) {
                if (pending.length) {
                    yield pending.shift();
                    continue;
                }
                if (failure) throw failure;
                if (finished) return;
                await new Promise((resolve) => { wake = resolve; });
            }
        }
    };
}

/**
 * 刷新目标目录项：POSIX 下对目录做 fsync；Windows 不允许对目录句柄 fsync，
 * 改为重新读取一次目录项触发目录缓存刷新（文件本身在 rename 前已 fsync）。
 */
function syncDirectory(directory) {
    if (process.platform === 'win32') {
        try { fs.readdirSync(directory); } catch (_) {}
        return false;
    }
    let fd = null;
    try {
        fd = fs.openSync(directory, 'r');
        fs.fsyncSync(fd);
        return true;
    } catch (_) {
        return false;
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (_) {}
        }
    }
}

function safeUnlink(filePath) {
    if (!filePath) return;
    try { fs.unlinkSync(filePath); } catch (_) {}
}

/**
 * 解析最终落盘路径：先按路径安全工具校验文件名（穿越、保留名、备用数据流、符号链接越权），
 * 再按覆盖策略决定目标路径。默认不覆盖同名文件，自动追加「 (2)」形式递增后缀。
 */
function resolveDeliveryTargetPath(directory, filename, { allowOverwrite = false } = {}) {
    const root = assertWritableDirectory(directory);
    const desiredPath = resolveWithinRoot(root, filename, { allowSubdirectories: false });
    const desiredName = path.basename(desiredPath);
    if (allowOverwrite) {
        return { root, targetPath: desiredPath, filename: desiredName, overwritten: fs.existsSync(desiredPath) };
    }
    const targetPath = resolveNonConflictingPath(root, desiredName);
    assertRealPathInside(root, targetPath);
    return { root, targetPath, filename: path.basename(targetPath), overwritten: false };
}

/**
 * 原子写入交付文件。
 * @param {object} options 写入参数
 * @param {string} options.directory 用户显式授权的目标目录（绝对路径）
 * @param {string} options.filename 服务端按 format 白名单决定的文件名
 * @param {string} options.expectedDigest 期望的 sha256（rendition.content_digest）
 * @param {*} options.source 字节来源：Buffer、异步可迭代流或事件式流
 * @param {boolean} options.allowOverwrite 是否允许覆盖同名文件（仅用户显式勾选时为真）
 * @param {number} options.maxBytes 单次写入体积上限，超限即中止
 * @param {object} options.hooks 可注入钩子；beforeRename 用于原子性用例强制中断
 * @returns {Promise<object>} 落盘结果
 */
async function writeDeliveryFile(options = {}) {
    const {
        directory,
        filename,
        expectedDigest = '',
        source,
        allowOverwrite = false,
        maxBytes = 0,
        hooks = {}
    } = options;
    const target = resolveDeliveryTargetPath(directory, filename, { allowOverwrite });
    const tempPath = path.join(target.root, `.pivot-delivery-${crypto.randomBytes(8).toString('hex')}.tmp`);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let fd = null;
    try {
        fd = fs.openSync(tempPath, 'wx', 0o600);
        for await (const chunk of toAsyncIterable(source)) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (maxBytes && bytes > Number(maxBytes)) {
                throw writeError('交付内容超过本机单次写入体积上限，已中止写入。', 'DELIVERY_SIZE_LIMIT_EXCEEDED', false);
            }
            hash.update(buffer);
            fs.writeSync(fd, buffer, 0, buffer.length);
        }
        // fsync 临时文件，确保数据在 rename 前已落到存储介质。
        fs.fsyncSync(fd);
    } catch (error) {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (_) {}
            fd = null;
        }
        safeUnlink(tempPath);
        throw error;
    }
    try { fs.closeSync(fd); } catch (_) {}
    const digest = hash.digest('hex');
    const expected = String(expectedDigest || '').trim().toLowerCase();
    if (expected && digest !== expected) {
        // 摘要不一致意味着传输或篡改问题，重试无意义：删除临时文件并标记不可重试。
        safeUnlink(tempPath);
        const error = writeError('交付内容摘要与登记摘要不一致，已删除临时文件且不重试。', 'DELIVERY_DIGEST_MISMATCH', false);
        error.actualDigest = digest;
        error.expectedDigest = expected;
        throw error;
    }
    try {
        if (typeof hooks.beforeRename === 'function') await hooks.beforeRename({ tempPath, targetPath: target.targetPath, digest, bytes });
        fs.renameSync(tempPath, target.targetPath);
    } catch (error) {
        // rename 之前失败：临时文件删除，目标路径保持原样（不存在或仍是完整旧文件）。
        safeUnlink(tempPath);
        throw error;
    }
    syncDirectory(target.root);
    return {
        targetPath: target.targetPath,
        filename: target.filename,
        directory: target.root,
        digest,
        bytes,
        overwritten: target.overwritten === true
    };
}

module.exports = {
    assertWritableDirectory,
    resolveDeliveryTargetPath,
    syncDirectory,
    toAsyncIterable,
    writeDeliveryFile
};
