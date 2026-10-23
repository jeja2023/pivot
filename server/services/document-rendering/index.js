/**
 * server/services/document-rendering/index.js
 * 文档渲染器注册表
 *
 * 落地方案 v1.2 §7.2、§7.3：
 * 1. DOCX 出口全项目唯一，所有格式都从 Document IR 渲染，不允许第二条导出路径；
 * 2. 渲染器语义版本参与 rendition 去重键，改版式必须升版本，否则历史交付不可复现；
 * 3. 渲染必须是确定性的：同一 IR、同一格式、同一渲染器版本连续渲染，内容摘要一致。
 */
const { recordRenderResult } = require('../agent-governance-metrics');
const { validateDocumentIr } = require('../document-ir');

const SUPPORTED_FORMATS = Object.freeze(['docx', 'pdf', 'xlsx', 'html', 'md', 'svg', 'png', 'wav']);

function renderError(message, code = 'DOCUMENT_RENDER_FAILED', status = 422) {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    error.expose = true;
    return error;
}

/** 惰性加载各渲染器，避免任一格式的依赖缺失导致整个服务无法启动。 */
function loadRenderer(format) {
    if (format === 'wav') return { format, version: '1.0.0', mimeType: 'audio/wav', available: () => true, render: async (ir, options) => {
        const blocks = ir.blocks.filter(block => block.type === 'audio');
        if (blocks.length !== 1 || !options.imageResolver) throw new Error('音频导出需要一个受控音频资产。');
        const bytes = await options.imageResolver(blocks[0].asset_ref);
        if (!bytes || bytes.length > 9 * 1024 * 1024 || bytes.subarray(0, 4).toString() !== 'RIFF' || bytes.subarray(8, 12).toString() !== 'WAVE') throw new Error('音频资产格式无效或超过大小上限。');
        return bytes;
    } };
    if (format === 'svg' || format === 'png') {
        return { format, version: '1.0.0', mimeType: format === 'svg' ? 'image/svg+xml' : 'image/png', available: () => true,
            render: (ir, options) => require('./image-renderer').renderImage(ir, format, options) };
    }
    if (format === 'docx') {
        const module = require('./docx-renderer');
        return {
            format,
            version: module.RENDERER_VERSION,
            mimeType: module.MIME_TYPE,
            available: () => true,
            render: (ir, options) => module.renderDocx(ir, options)
        };
    }
    if (format === 'pdf') {
        const module = require('./pdf-renderer');
        return {
            format,
            version: module.RENDERER_VERSION,
            mimeType: module.MIME_TYPE,
            available: () => module.isPdfRenderingAvailable(),
            render: (ir, options) => module.renderPdf(ir, options)
        };
    }
    if (format === 'xlsx') {
        const module = require('./xlsx-renderer');
        return {
            format,
            version: module.XLSX_RENDERER_VERSION,
            mimeType: module.XLSX_MIME_TYPE,
            available: () => true,
            render: (ir, options) => module.renderXlsx(ir, options)
        };
    }
    const module = require('./text-renderers');
    if (format === 'html') {
        return {
            format,
            version: module.HTML_RENDERER_VERSION,
            mimeType: module.HTML_MIME_TYPE,
            available: () => true,
            render: (ir, options) => module.renderHtml(ir, options)
        };
    }
    return {
        format,
        version: module.MARKDOWN_RENDERER_VERSION,
        mimeType: module.MARKDOWN_MIME_TYPE,
        available: () => true,
        render: (ir, options) => module.renderMarkdown(ir, options)
    };
}

function normalizeFormat(value) {
    const format = String(value || '').trim().toLowerCase();
    if (!SUPPORTED_FORMATS.includes(format)) {
        throw renderError(`不支持的渲染格式：${value || '(空)'}。支持的格式为 ${SUPPORTED_FORMATS.join('、')}。`, 'DOCUMENT_FORMAT_UNSUPPORTED', 400);
    }
    return format;
}

function getRenderer(format) {
    return loadRenderer(normalizeFormat(format));
}

/** 列出各格式的渲染器版本与可用性，供管理端与自检使用。 */
function listRendererStatus() {
    return SUPPORTED_FORMATS.map(format => {
        try {
            const renderer = loadRenderer(format);
            return { format, version: renderer.version, mimeType: renderer.mimeType, available: renderer.available() };
        } catch (error) {
            return { format, version: '', mimeType: '', available: false, reason: String(error.message || error) };
        }
    });
}

/**
 * 从 IR 渲染指定格式。
 * IR 校验失败即拒绝渲染（不做尽力渲染），错误信息为可操作中文，便于 Agent 自我修正。
 */
async function renderDocumentIr(ir, format, options = {}) {
    const safeFormat = normalizeFormat(format);
    const checked = options.skipValidation === true ? { valid: true, ir, errors: [] } : validateDocumentIr(ir);
    if (!checked.valid) {
        recordRenderResult({ format: safeFormat, failureReason: 'ir_invalid' });
        throw renderError(`Document IR 校验失败：${checked.errors.join('；')}`, 'DOCUMENT_IR_INVALID');
    }
    if (!['docx', 'html', 'md'].includes(safeFormat) && checked.ir.blocks.some(block => block.paragraphRevision || block.runs?.some(run => run.revision))) {
        throw renderError('当前格式不能保留修订语义，请使用 DOCX 或 HTML 对照。', 'DOCUMENT_REVISION_FORMAT_UNSUPPORTED', 422);
    }
    const renderer = getRenderer(safeFormat);
    if (!renderer.available()) {
        recordRenderResult({ format: safeFormat, failureReason: 'renderer_unavailable' });
        throw renderError(`${safeFormat.toUpperCase()} 渲染能力当前不可用，已按 fail-closed 策略拒绝渲染。`, 'DOCUMENT_RENDERER_UNAVAILABLE', 503);
    }
    const startedAt = Date.now();
    let buffer;
    try {
        buffer = await renderer.render(checked.ir, options);
    } catch (error) {
        recordRenderResult({ format: safeFormat, failureReason: error.code || 'render_exception' });
        throw error;
    }
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        recordRenderResult({ format: safeFormat, failureReason: 'empty_output' });
        throw renderError('渲染器返回了空内容。', 'DOCUMENT_RENDER_EMPTY', 500);
    }
    const durationMs = Date.now() - startedAt;
    recordRenderResult({ format: safeFormat, durationMs });
    return { buffer, mimeType: renderer.mimeType, rendererVersion: renderer.version, format: safeFormat, durationMs, ir: checked.ir };
}

module.exports = {
    SUPPORTED_FORMATS,
    getRenderer,
    listRendererStatus,
    normalizeFormat,
    renderDocumentIr,
    renderError
};
