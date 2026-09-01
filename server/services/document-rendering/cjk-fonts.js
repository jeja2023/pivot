/**
 * server/services/document-rendering/cjk-fonts.js
 * PDF 渲染所需 CJK 字体的部署资产自检与加载
 *
 * 落地方案 v1.2 §7.2「CJK 字体的分发与授权」、阶段 2.5：
 * 1. 字体文件是部署包资产（随发布制品进内网制品库），运行时禁止下载任何资源；
 * 2. 启动自检逐字节校验 SHA-256，校验失败或文件缺失时 PDF 渲染能力显式下线并向
 *    管理端告警（fail-closed），不得回退为方块、乱码或静默跳过；
 * 3. 只允许 SIL OFL 1.1 授权的开源中文字体（思源黑体 / 思源宋体 / Noto Sans CJK 等）；
 *    随 Windows 授权的 SimSun、FangSong 等系统字体不得作为分发资产，因此本模块不内置
 *    任何系统字体路径默认值，缺配置即保持能力下线。
 *
 * 自检结果与字体字节缓存在模块内：字体是十几 MB 的部署资产，每次渲染重复读盘与哈希
 * 不可接受。部署期更换字体后需调用 resetCjkFontCache() 或重启进程。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fontkit = require('@pdf-lib/fontkit');
const { logger } = require('../../logger');
const { recordFontSelfcheckFailure } = require('../agent-governance-metrics');

/** 字体资产的环境变量约定（键名 → 中文说明），供管理端自检页与部署文档复用。 */
const FONT_ENV_KEYS = Object.freeze({
    PIVOT_PDF_FONT_DIR: '字体资产目录。部署包把 OFL 授权的中文字体放进该目录，运行时只读，不下载。',
    PIVOT_PDF_FONT_FILE: '字体文件名或绝对路径。相对值相对 PIVOT_PDF_FONT_DIR 解析；留空时在目录内按文件名排序确定性选取一个。',
    PIVOT_PDF_FONT_SHA256: '期望的字体文件 SHA-256（64 位小写十六进制）。配置后每次自检逐字节校验，不一致立即下线 PDF 能力。'
});

/** 字体集合（.ttc）内的字面选择键，取值为 PostScript 名；单字体文件无需配置。 */
const FONT_FACE_ENV_KEY = 'PIVOT_PDF_FONT_FACE';

/** PDF 内嵌字体的固定资源名。该值进入 PDF 字节，必须是常量，否则破坏渲染幂等性。 */
const FONT_SUBSET_NAME = 'PivotCjkSubset';

/** 只接受这三类字体容器：TrueType、OpenType 与 TrueType 集合。 */
const ALLOWED_FONT_EXTENSIONS = Object.freeze(['.ttf', '.otf', '.ttc']);

/** 字体资产体积上限。误配指向大文件时提前拒绝，避免自检把进程内存打满。 */
const MAX_FONT_BYTES = 64 * 1024 * 1024;

/** 自检必须覆盖的码点：文件本身合法但缺中文字形时，PDF 会输出空白或方块。 */
const REQUIRED_CODE_POINTS = Object.freeze([0x4e2d, 0x6587, 0x3002, 0xff0c]);

/** 默认字体资产目录。部署时把 OFL 字体放进该目录即可，不需要额外配置环境变量。 */
const DEFAULT_FONT_DIR = path.resolve(__dirname, '../../../assets/fonts/cjk');

let cachedResult = null;
let cachedBuffer = null;

function readEnv(key) {
    return String(process.env[key] || '').trim();
}

function buildFailure(reason, extra = {}) {
    return {
        available: false,
        reason,
        fontPath: String(extra.fontPath || ''),
        sha256: String(extra.sha256 || ''),
        sizeBytes: Number(extra.sizeBytes || 0),
        faceName: String(extra.faceName || '')
    };
}

/** 在目录内确定性选取字体：优先 OFL 的思源 / Noto 系列，其余按文件名排序取第一个。 */
function pickFontFromDir(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
        return { fontPath: '', reason: `字体资产目录不可读：${dir}，原因：${error.message}。` };
    }
    const candidates = entries
        .filter(entry => entry.isFile() && ALLOWED_FONT_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
        .map(entry => entry.name)
        .sort();
    if (!candidates.length) {
        return { fontPath: '', reason: `字体资产目录 ${dir} 内没有 ${ALLOWED_FONT_EXTENSIONS.join(' / ')} 字体文件。` };
    }
    const preferred = candidates.find(name => /(noto|sourcehan|source[-_ ]?han|siyuan)/i.test(name));
    return { fontPath: path.join(dir, preferred || candidates[0]), reason: '' };
}

/** 解析配置指向的字体文件路径。返回空路径表示未配置或目录缺失，属于预期的能力下线路径。 */
function resolveConfiguredFont() {
    const configuredFile = readEnv('PIVOT_PDF_FONT_FILE');
    if (configuredFile && path.isAbsolute(configuredFile)) {
        return { fontPath: path.resolve(configuredFile), reason: '' };
    }
    const configuredDir = readEnv('PIVOT_PDF_FONT_DIR');
    const dir = configuredDir ? path.resolve(configuredDir) : DEFAULT_FONT_DIR;
    if (!fs.existsSync(dir)) {
        const hint = configuredDir
            ? `配置的字体资产目录不存在：${dir}。`
            : `未配置 PIVOT_PDF_FONT_DIR / PIVOT_PDF_FONT_FILE，且默认字体资产目录不存在：${dir}。`;
        return { fontPath: '', reason: `${hint}请把 OFL 授权的中文字体随部署包放入该目录后重启服务。` };
    }
    if (!configuredFile) return pickFontFromDir(dir);
    const fontPath = path.resolve(dir, configuredFile);
    const relative = path.relative(dir, fontPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return { fontPath: '', reason: `PIVOT_PDF_FONT_FILE 指向了字体资产目录之外的路径：${configuredFile}。请改用绝对路径或目录内的文件名。` };
    }
    return { fontPath, reason: '' };
}

/**
 * 解析字体字节并选定字面。
 * .ttc 集合的解析结果是集合对象而不是字体，pdf-lib 直接嵌入会得到 NaN 度量，必须先选字面。
 */
function loadFontFace(buffer, faceName) {
    let parsed;
    try {
        parsed = fontkit.create(buffer);
    } catch (error) {
        return { error: `字体文件解析失败：${error.message}。文件可能已损坏或不是受支持的字体容器。` };
    }
    if (!parsed) return { error: '字体文件解析结果为空，无法用于 PDF 嵌入。' };
    if (!Array.isArray(parsed.fonts)) {
        return { font: parsed, faceName: String(parsed.postscriptName || '') };
    }
    const names = parsed.fonts.map(item => String(item.postscriptName || '')).filter(Boolean);
    if (faceName) {
        const picked = parsed.fonts.find(item => String(item.postscriptName || '') === faceName);
        if (!picked) {
            return { error: `字体集合内没有 ${FONT_FACE_ENV_KEY} 指定的字面 ${faceName}，可选字面：${names.join('、') || '(无)'}。` };
        }
        return { font: picked, faceName };
    }
    const first = parsed.fonts[0];
    if (!first) return { error: '字体集合内没有可用字面。' };
    return { font: first, faceName: String(first.postscriptName || '') };
}

function runSelfcheck() {
    cachedBuffer = null;
    const resolved = resolveConfiguredFont();
    if (!resolved.fontPath) return buildFailure(resolved.reason);
    const fontPath = resolved.fontPath;
    const extension = path.extname(fontPath).toLowerCase();
    if (!ALLOWED_FONT_EXTENSIONS.includes(extension)) {
        return buildFailure(`字体文件扩展名 ${extension || '(空)'} 不受支持，只接受 ${ALLOWED_FONT_EXTENSIONS.join(' / ')}。`, { fontPath });
    }
    let stat;
    try {
        stat = fs.statSync(fontPath);
    } catch (error) {
        return buildFailure(`字体文件不存在或不可访问：${fontPath}，原因：${error.message}。`, { fontPath });
    }
    if (!stat.isFile()) return buildFailure(`字体路径不是普通文件：${fontPath}。`, { fontPath });
    if (!stat.size) return buildFailure(`字体文件为空：${fontPath}。`, { fontPath });
    if (stat.size > MAX_FONT_BYTES) {
        return buildFailure(`字体文件体积 ${stat.size} 字节超过上限 ${MAX_FONT_BYTES} 字节，疑为配置错误。`, { fontPath, sizeBytes: stat.size });
    }
    let buffer;
    try {
        buffer = fs.readFileSync(fontPath);
    } catch (error) {
        return buildFailure(`字体文件读取失败：${fontPath}，原因：${error.message}。`, { fontPath, sizeBytes: stat.size });
    }
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const expected = readEnv('PIVOT_PDF_FONT_SHA256').toLowerCase();
    const measured = { fontPath, sha256, sizeBytes: buffer.length };
    if (expected) {
        if (!/^[0-9a-f]{64}$/.test(expected)) {
            return buildFailure(`PIVOT_PDF_FONT_SHA256 不是 64 位小写十六进制摘要，当前取值长度为 ${expected.length}。`, measured);
        }
        if (expected !== sha256) {
            return buildFailure(`字体文件 SHA-256 校验不一致：期望 ${expected}，实际 ${sha256}。字体资产可能被替换或传输损坏。`, measured);
        }
    } else {
        logger.warn({ fontPath, sha256 }, '字体资产未配置 PIVOT_PDF_FONT_SHA256，完整性未锁定，建议在部署配置中补齐摘要。');
    }
    const face = loadFontFace(buffer, readEnv(FONT_FACE_ENV_KEY));
    if (face.error) return buildFailure(face.error, measured);
    const missing = REQUIRED_CODE_POINTS.filter(codePoint => {
        try {
            return !face.font.hasGlyphForCodePoint(codePoint);
        } catch (error) {
            return true;
        }
    });
    if (missing.length) {
        const points = missing.map(codePoint => `U+${codePoint.toString(16).toUpperCase()}`).join('、');
        return buildFailure(`字体缺少必需的中文字形（${points}），继续渲染只会得到空白或方块，已按 fail-closed 策略下线。`, { ...measured, faceName: face.faceName });
    }
    cachedBuffer = buffer;
    return {
        available: true,
        reason: '字体自检通过。',
        fontPath,
        sha256,
        sizeBytes: buffer.length,
        faceName: face.faceName
    };
}

/**
 * CJK 字体自检。返回 { available, reason, fontPath, sha256, sizeBytes, faceName }。
 * 结果缓存在模块内；自检失败时上报治理指标并写错误日志，供管理端告警（方案 §8.2）。
 */
function verifyCjkFont() {
    if (cachedResult) return cachedResult;
    const result = runSelfcheck();
    cachedResult = Object.freeze(result);
    if (!result.available) {
        recordFontSelfcheckFailure();
        logger.error({ fontPath: result.fontPath, reason: result.reason }, 'CJK 字体自检失败，PDF 渲染能力已显式下线，请检查字体资产配置。');
    } else {
        logger.info({ fontPath: result.fontPath, sha256: result.sha256, sizeBytes: result.sizeBytes, faceName: result.faceName }, 'CJK 字体自检通过，PDF 渲染能力可用。');
    }
    return cachedResult;
}

/** 清空自检缓存。部署期替换字体资产、或测试切换环境变量后调用。 */
function resetCjkFontCache() {
    cachedResult = null;
    cachedBuffer = null;
}

function isCjkFontAvailable() {
    return verifyCjkFont().available;
}

function fontUnavailableError(reason) {
    const error = new Error(`PDF 渲染能力已下线：${reason || 'CJK 字体不可用。'}`);
    error.status = 503;
    error.statusCode = 503;
    error.code = 'PDF_FONT_UNAVAILABLE';
    error.expose = true;
    return error;
}

/** 取字体字节。不可用时抛 503 中文错误，绝不回退到可能渲染成乱码的替代字体。 */
function getCjkFontBuffer() {
    const result = verifyCjkFont();
    if (!result.available || !cachedBuffer) throw fontUnavailableError(result.reason);
    return cachedBuffer;
}

/** 取自检选定的字面名（.ttc 集合场景非空），供渲染器与管理端展示使用。 */
function getCjkFontFaceName() {
    return verifyCjkFont().faceName || '';
}

/**
 * 构造给 pdf-lib registerFontkit 使用的 fontkit 适配器。
 * pdf-lib 只以单参数调用 create()，遇到 .ttc 会拿到集合对象，因此在这里统一收敛到
 * 自检选定的字面，保证嵌入的字面与自检校验过的字面完全一致。
 */
function createCjkFontkit() {
    const faceName = getCjkFontFaceName();
    return {
        create(data) {
            const face = loadFontFace(Buffer.isBuffer(data) ? data : Buffer.from(data), faceName);
            if (face.error) throw fontUnavailableError(face.error);
            return face.font;
        }
    };
}

module.exports = {
    ALLOWED_FONT_EXTENSIONS,
    DEFAULT_FONT_DIR,
    FONT_ENV_KEYS,
    FONT_FACE_ENV_KEY,
    FONT_SUBSET_NAME,
    MAX_FONT_BYTES,
    createCjkFontkit,
    getCjkFontBuffer,
    getCjkFontFaceName,
    isCjkFontAvailable,
    resetCjkFontCache,
    verifyCjkFont
};
