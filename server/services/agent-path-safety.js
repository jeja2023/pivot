/**
 * server/services/agent-path-safety.js
 * 统一路径安全工具
 *
 * 落地方案 v1.2 §7.7 第 3 条明确要求：Skill 包条目校验（B7）与本机交付写入
 * 必须共用同一套路径安全实现，不各写一份。本模块是该实现的唯一来源，
 * 覆盖：路径穿越、空字节、绝对路径与盘符、UNC、符号链接、Windows 保留名、
 * 尾随空格与点、备用数据流（ADS）以及扩展名白名单。
 *
 * 本模块只依赖 node 内置模块，可被服务端与打包后的桌面端共同引用。
 */
const fs = require('fs');
const path = require('path');

/** Windows 保留设备名。含扩展名的形式（如 CON.txt）同样被系统特殊对待，必须一并拒绝。 */
const WINDOWS_RESERVED_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

/** 交付允许的文档扩展名。服务端按 rendition.format 决定，不接受交付端或 IR 指定。 */
const DELIVERY_EXTENSION_BY_FORMAT = Object.freeze({
    docx: '.docx',
    pdf: '.pdf',
    xlsx: '.xlsx',
    html: '.html',
    md: '.md'
});

const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

function pathError(message, code = 'AGENT_PATH_UNSAFE') {
    const error = new Error(message);
    error.code = code;
    error.category = 'permission';
    return error;
}

function isWindowsReservedName(value) {
    const base = String(value || '').split(/[\\/]/).pop() || '';
    const stem = base.split('.')[0] || '';
    return WINDOWS_RESERVED_NAMES.has(stem.trim().toUpperCase());
}

function hasTrailingDotOrSpace(value) {
    return /[ .]$/.test(String(value || ''));
}

/**
 * 判定是否包含 NTFS 备用数据流写法（file.txt:stream）。
 * 相对条目路径中不应出现冒号，盘符形态由 isAbsoluteOrDriveQualified 单独拦截。
 */
function hasAlternateDataStream(value) {
    return String(value || '').replace(/\\/g, '/').split('/').some(segment => segment.includes(':'));
}

function isAbsoluteOrDriveQualified(value) {
    const text = String(value || '');
    return text.startsWith('/') || text.startsWith('\\') || /^[A-Za-z]:/.test(text) || text.startsWith('\\\\');
}

/**
 * 规范化压缩包/交付条目的相对路径。任何越权形态一律抛错，不做静默修正。
 * 返回 POSIX 风格相对路径。
 */
function normalizeRelativeEntryPath(value, { allowSubdirectories = true } = {}) {
    const raw = String(value ?? '');
    if (!raw.trim()) throw pathError('路径为空。');
    if (raw.includes('\0')) throw pathError('路径包含空字节。');
    if (isAbsoluteOrDriveQualified(raw)) throw pathError('路径不允许为绝对路径或包含盘符。');
    const posixRaw = raw.replace(/\\/g, '/');
    // 先在原始路径上拒绝任何 .. 片段：规范化会把 a/../b 悄悄改写为 b，
    // 静默修正会掩盖攻击意图，也让审计无法还原原始请求。
    if (posixRaw.split('/').some(segment => segment === '..')) throw pathError('路径包含越权跳转。');
    const normalized = path.posix.normalize(posixRaw);
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
        throw pathError('路径包含越权跳转。');
    }
    if (normalized.startsWith('/')) throw pathError('路径不允许为绝对路径或包含盘符。');
    const segments = normalized.split('/').filter(segment => segment && segment !== '.');
    if (!segments.length) throw pathError('路径为空。');
    if (!allowSubdirectories && segments.length > 1) throw pathError('该场景只允许单层文件名。');
    segments.forEach(segment => {
        if (isWindowsReservedName(segment)) throw pathError(`路径包含系统保留名：${segment}`);
        if (hasTrailingDotOrSpace(segment)) throw pathError('路径片段不允许以空格或点结尾。');
        if (segment.includes(':')) throw pathError('路径不允许包含备用数据流写法。');
    });
    return segments.join('/');
}

/** 判定 ZIP 条目的外部属性高位是否为符号链接（S_IFLNK = 0xA000）。 */
function isSymlinkExternalAttributes(externalFileAttributes) {
    const attributes = Number(externalFileAttributes) || 0;
    const unixMode = (attributes >>> 16) & 0xFFFF;
    return (unixMode & 0xF000) === 0xA000;
}

/**
 * 校验 realpath 后的目标仍位于授权根目录内。
 * 目标可以尚不存在：逐级回溯到已存在的祖先做 realpath，再拼回剩余片段。
 */
function assertRealPathInside(root, target) {
    let existing = path.resolve(target);
    const suffix = [];
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        suffix.unshift(path.basename(existing));
        existing = parent;
    }
    let realRoot;
    let realExisting;
    try {
        realRoot = fs.realpathSync(path.resolve(root));
        realExisting = fs.realpathSync(existing);
    } catch (_) {
        throw pathError('授权目录不可解析。', 'AGENT_PATH_ROOT_UNAVAILABLE');
    }
    const realTarget = path.join(realExisting, ...suffix);
    const relative = path.relative(realRoot, realTarget);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw pathError('目标路径经符号链接解析后越出授权目录。', 'AGENT_PATH_SYMLINK_ESCAPE');
    }
    return realTarget;
}

/** 在授权根目录内解析相对路径，并完成 realpath 越权校验。 */
function resolveWithinRoot(root, relativePath, options = {}) {
    const safeRelative = normalizeRelativeEntryPath(relativePath, options);
    const target = path.resolve(path.resolve(root), safeRelative);
    const rootResolved = path.resolve(root);
    const relative = path.relative(rootResolved, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw pathError('目标路径越出授权目录。');
    }
    assertRealPathInside(rootResolved, target);
    return target;
}

/**
 * 生成安全的交付文件名。扩展名由服务端按 format 决定，不接受调用方指定可执行扩展名。
 */
function buildDeliveryFilename(rawName, format, { maxLength = 120 } = {}) {
    const extension = DELIVERY_EXTENSION_BY_FORMAT[String(format || '').toLowerCase()];
    if (!extension) throw pathError(`不支持的交付格式：${format}`, 'AGENT_DELIVERY_FORMAT_UNSUPPORTED');
    const base = String(rawName || '').split(/[\\/]/).pop() || '';
    const stem = base.replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(UNSAFE_FILENAME_CHARS, '_').replace(/[ .]+$/g, '').trim();
    const safeStem = (stem || '交付文档').slice(0, maxLength);
    if (isWindowsReservedName(safeStem)) return `文档_${safeStem}${extension}`;
    return `${safeStem}${extension}`;
}

/** 同名不覆盖策略：追加 (2)(3)... 递增后缀，直到找到不存在的路径。 */
function resolveNonConflictingPath(directory, filename, { exists = fs.existsSync, maxAttempts = 200 } = {}) {
    const extension = path.extname(filename);
    const stem = filename.slice(0, filename.length - extension.length);
    let candidate = path.join(directory, filename);
    let index = 1;
    while (exists(candidate) && index < maxAttempts) {
        index += 1;
        candidate = path.join(directory, `${stem} (${index})${extension}`);
    }
    if (exists(candidate)) throw pathError('目标目录同名文件过多，已停止追加后缀。', 'AGENT_DELIVERY_NAME_EXHAUSTED');
    return candidate;
}

module.exports = {
    DELIVERY_EXTENSION_BY_FORMAT,
    WINDOWS_RESERVED_NAMES,
    assertRealPathInside,
    buildDeliveryFilename,
    hasAlternateDataStream,
    hasTrailingDotOrSpace,
    isSymlinkExternalAttributes,
    isWindowsReservedName,
    normalizeRelativeEntryPath,
    pathError,
    resolveNonConflictingPath,
    resolveWithinRoot
};
