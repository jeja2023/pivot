/**
 * server/services/document-ir.js
 * Document IR（结构化文档中间表示）契约与校验器
 *
 * 落地方案 v1.2 §7.1、阶段 2.1：
 * 1. Agent 侧只产出 IR，二进制文件一律由服务端 Renderer 从 IR 渲染；
 * 2. IR 是 JSON，可 schema 校验、可审计、可重放、可跨版本比对；
 * 3. doc_type 决定允许的 block 集合与必填 meta 字段，由服务端白名单校验，
 *    不接受 IR 自带扩展字段；
 * 4. 图片只能以已授权的 artifact-cas:// 引用出现，禁止内联 base64；
 * 5. 校验失败即拒绝渲染，不做「尽力渲染」。
 *
 * 规范化（canonicalize）是幂等渲染的前提：同一语义 IR 必须得到同一摘要，
 * 因此规范化会补全默认值并按稳定顺序输出，再由 canonicalJson 计算 sha256。
 */
const crypto = require('crypto');
const { canonicalJson } = require('./agent-skills');

const IR_VERSION = '1';

const DOC_TYPES = Object.freeze(['official_document', 'report', 'table', 'memo']);
const BLOCK_TYPES = Object.freeze(['heading', 'paragraph', 'table', 'list', 'page_break', 'image']);
const SECURITY_LEVELS = Object.freeze(['public', 'internal', 'confidential', 'secret']);
const PAGE_SIZES = Object.freeze(['A4', 'A3', 'Letter']);
const ALIGNMENTS = Object.freeze(['left', 'center', 'right', 'justify']);

/** 各 doc_type 允许的 block 与必填 meta。 */
const DOC_TYPE_RULES = Object.freeze({
    official_document: { blocks: BLOCK_TYPES, requiredMeta: ['title', 'issuer'] },
    report: { blocks: BLOCK_TYPES, requiredMeta: ['title'] },
    table: { blocks: ['heading', 'paragraph', 'table', 'page_break'], requiredMeta: ['title'] },
    memo: { blocks: ['heading', 'paragraph', 'list'], requiredMeta: ['title'] }
});

/** 公文默认页面设置（GB/T 9704 常用值，单位毫米）。 */
const OFFICIAL_PAGE_DEFAULT = Object.freeze({
    size: 'A4',
    orientation: 'portrait',
    margin_mm: Object.freeze({ top: 37, bottom: 35, left: 28, right: 26 })
});

const GENERAL_PAGE_DEFAULT = Object.freeze({
    size: 'A4',
    orientation: 'portrait',
    margin_mm: Object.freeze({ top: 25, bottom: 25, left: 25, right: 25 })
});

/** 规模上限（R9：渲染器不得成为新的资源消耗点）。 */
const MAX_BLOCKS = 2000;
const MAX_TABLE_CELLS = 20000;
const MAX_RUNS_PER_PARAGRAPH = 500;
const MAX_TEXT_LENGTH = 20000;
const MAX_LIST_ITEMS = 500;
const CAS_REF_PATTERN = /^artifact-cas:\/\/[0-9a-f]{16,64}$/;

const ALLOWED_TOP_FIELDS = Object.freeze(new Set(['ir_version', 'doc_type', 'meta', 'blocks', 'footer']));
const ALLOWED_META_FIELDS = Object.freeze(new Set(['title', 'doc_number', 'issuer', 'issued_at', 'security_level', 'page', 'subtitle', 'recipient', 'signoff']));
const ALLOWED_PAGE_FIELDS = Object.freeze(new Set(['size', 'orientation', 'margin_mm']));
const ALLOWED_STYLE_FIELDS = Object.freeze(new Set(['indent_chars', 'line_height', 'align', 'font', 'space_after_pt']));
const ALLOWED_FONT_FIELDS = Object.freeze(new Set(['eastAsia', 'ascii', 'size_pt', 'bold', 'color', 'family_chain']));
const ALLOWED_RUN_FIELDS = Object.freeze(new Set(['text', 'bold', 'italic', 'underline', 'color', 'font']));
const ALLOWED_FOOTER_FIELDS = Object.freeze(new Set(['page_number', 'format']));

function unknownFields(source, allowed) {
    if (!source || typeof source !== 'object') return [];
    return Object.keys(source).filter(key => !allowed.has(key));
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
}

function normalizeText(value) {
    return String(value ?? '');
}

function validateMeta(meta, docType, errors) {
    if (!isPlainObject(meta)) {
        errors.push('meta 必须是对象。');
        return;
    }
    unknownFields(meta, ALLOWED_META_FIELDS).forEach(key => errors.push(`meta 含未知字段：${key}`));
    (DOC_TYPE_RULES[docType]?.requiredMeta || []).forEach(field => {
        if (!String(meta[field] ?? '').trim()) errors.push(`doc_type=${docType} 要求 meta.${field} 不能为空。`);
    });
    if (meta.security_level !== undefined && !SECURITY_LEVELS.includes(String(meta.security_level))) {
        errors.push(`meta.security_level 只能是 ${SECURITY_LEVELS.join('、')}。`);
    }
    if (meta.issued_at !== undefined && meta.issued_at !== null && meta.issued_at !== ''
        && !/^\d{4}-\d{2}-\d{2}$/.test(String(meta.issued_at))) {
        errors.push('meta.issued_at 必须是 YYYY-MM-DD 格式。');
    }
    if (meta.page !== undefined) {
        if (!isPlainObject(meta.page)) {
            errors.push('meta.page 必须是对象。');
        } else {
            unknownFields(meta.page, ALLOWED_PAGE_FIELDS).forEach(key => errors.push(`meta.page 含未知字段：${key}`));
            if (meta.page.size !== undefined && !PAGE_SIZES.includes(String(meta.page.size))) {
                errors.push(`meta.page.size 只能是 ${PAGE_SIZES.join('、')}。`);
            }
            if (meta.page.orientation !== undefined && !['portrait', 'landscape'].includes(String(meta.page.orientation))) {
                errors.push('meta.page.orientation 只能是 portrait 或 landscape。');
            }
            if (meta.page.margin_mm !== undefined && !isPlainObject(meta.page.margin_mm)) {
                errors.push('meta.page.margin_mm 必须是对象。');
            }
        }
    }
}

function validateStyle(style, location, errors) {
    if (style === undefined) return;
    if (!isPlainObject(style)) {
        errors.push(`${location}.style 必须是对象。`);
        return;
    }
    unknownFields(style, ALLOWED_STYLE_FIELDS).forEach(key => errors.push(`${location}.style 含未知字段：${key}`));
    if (style.align !== undefined && !ALIGNMENTS.includes(String(style.align))) {
        errors.push(`${location}.style.align 只能是 ${ALIGNMENTS.join('、')}。`);
    }
    if (style.font !== undefined) {
        if (!isPlainObject(style.font)) {
            errors.push(`${location}.style.font 必须是对象。`);
        } else {
            unknownFields(style.font, ALLOWED_FONT_FIELDS).forEach(key => errors.push(`${location}.style.font 含未知字段：${key}`));
            if (style.font.family_chain !== undefined && !Array.isArray(style.font.family_chain)) {
                errors.push(`${location}.style.font.family_chain 必须是数组。`);
            }
        }
    }
}

function validateBlock(block, index, docType, errors) {
    const location = `blocks[${index}]`;
    if (!isPlainObject(block)) {
        errors.push(`${location} 必须是对象。`);
        return;
    }
    const type = String(block.type || '');
    if (!BLOCK_TYPES.includes(type)) {
        errors.push(`${location}.type 不是受支持的块类型：${type || '(空)'}`);
        return;
    }
    const allowedForDoc = DOC_TYPE_RULES[docType]?.blocks || [];
    if (!allowedForDoc.includes(type)) {
        errors.push(`doc_type=${docType} 不允许块类型 ${type}。`);
        return;
    }
    if (type === 'heading') {
        const level = Number.parseInt(block.level, 10);
        if (!Number.isSafeInteger(level) || level < 1 || level > 4) errors.push(`${location}.level 必须是 1-4。`);
        if (!normalizeText(block.text).trim()) errors.push(`${location}.text 不能为空。`);
        if (normalizeText(block.text).length > MAX_TEXT_LENGTH) errors.push(`${location}.text 超过长度上限。`);
        validateStyle(block.style, location, errors);
        return;
    }
    if (type === 'paragraph') {
        if (!Array.isArray(block.runs)) {
            errors.push(`${location}.runs 必须是数组。`);
        } else {
            if (block.runs.length > MAX_RUNS_PER_PARAGRAPH) errors.push(`${location}.runs 超过 ${MAX_RUNS_PER_PARAGRAPH} 上限。`);
            block.runs.forEach((run, runIndex) => {
                if (!isPlainObject(run)) {
                    errors.push(`${location}.runs[${runIndex}] 必须是对象。`);
                    return;
                }
                unknownFields(run, ALLOWED_RUN_FIELDS).forEach(key => errors.push(`${location}.runs[${runIndex}] 含未知字段：${key}`));
                if (normalizeText(run.text).length > MAX_TEXT_LENGTH) errors.push(`${location}.runs[${runIndex}].text 超过长度上限。`);
            });
        }
        validateStyle(block.style, location, errors);
        return;
    }
    if (type === 'table') {
        if (!Array.isArray(block.header)) errors.push(`${location}.header 必须是数组。`);
        if (!Array.isArray(block.rows)) errors.push(`${location}.rows 必须是数组。`);
        const columnCount = Array.isArray(block.header) ? block.header.length : 0;
        if (!columnCount) errors.push(`${location}.header 不能为空。`);
        if (Array.isArray(block.rows)) {
            const cells = block.rows.reduce((total, row) => total + (Array.isArray(row) ? row.length : 0), 0);
            if (cells > MAX_TABLE_CELLS) errors.push(`${location} 单元格总数超过 ${MAX_TABLE_CELLS} 上限。`);
            block.rows.forEach((row, rowIndex) => {
                if (!Array.isArray(row)) {
                    errors.push(`${location}.rows[${rowIndex}] 必须是数组。`);
                    return;
                }
                if (columnCount && row.length !== columnCount) {
                    errors.push(`${location}.rows[${rowIndex}] 列数（${row.length}）与表头列数（${columnCount}）不一致。`);
                }
            });
        }
        if (block.widths_pct !== undefined) {
            if (!Array.isArray(block.widths_pct)) errors.push(`${location}.widths_pct 必须是数组。`);
            else if (columnCount && block.widths_pct.length !== columnCount) errors.push(`${location}.widths_pct 长度必须等于表头列数。`);
        }
        validateStyle(block.style, location, errors);
        return;
    }
    if (type === 'list') {
        if (!Array.isArray(block.items)) errors.push(`${location}.items 必须是数组。`);
        else if (block.items.length > MAX_LIST_ITEMS) errors.push(`${location}.items 超过 ${MAX_LIST_ITEMS} 上限。`);
        validateStyle(block.style, location, errors);
        return;
    }
    if (type === 'image') {
        const ref = String(block.asset_ref || '');
        if (!CAS_REF_PATTERN.test(ref)) {
            errors.push(`${location}.asset_ref 必须是 artifact-cas://<objectId> 受控引用，禁止内联 base64。`);
        }
        if (block.width_mm !== undefined && !Number.isFinite(Number(block.width_mm))) {
            errors.push(`${location}.width_mm 必须是数字。`);
        }
    }
}

/**
 * 校验 IR。返回 { valid, errors, ir }；valid=false 时 ir 为 null。
 * 错误信息为可操作中文，会回传到 agent_tool_calls 的失败原因，便于 Agent 自我修正。
 */
function validateDocumentIr(input) {
    const errors = [];
    if (!isPlainObject(input)) {
        return { valid: false, errors: ['IR 必须是 JSON 对象。'], ir: null };
    }
    unknownFields(input, ALLOWED_TOP_FIELDS).forEach(key => errors.push(`IR 含未知顶层字段：${key}`));
    if (String(input.ir_version ?? IR_VERSION) !== IR_VERSION) errors.push(`ir_version 只支持 ${IR_VERSION}。`);
    const docType = String(input.doc_type || '');
    if (!DOC_TYPES.includes(docType)) errors.push(`doc_type 只能是 ${DOC_TYPES.join('、')}。`);
    validateMeta(input.meta, docType, errors);
    if (!Array.isArray(input.blocks)) {
        errors.push('blocks 必须是数组。');
    } else if (!input.blocks.length) {
        errors.push('blocks 不能为空。');
    } else if (input.blocks.length > MAX_BLOCKS) {
        errors.push(`blocks 数量超过 ${MAX_BLOCKS} 上限。`);
    } else if (DOC_TYPES.includes(docType)) {
        input.blocks.forEach((block, index) => validateBlock(block, index, docType, errors));
    }
    if (input.footer !== undefined) {
        if (!isPlainObject(input.footer)) errors.push('footer 必须是对象。');
        else unknownFields(input.footer, ALLOWED_FOOTER_FIELDS).forEach(key => errors.push(`footer 含未知字段：${key}`));
    }
    if (errors.length) return { valid: false, errors, ir: null };
    return { valid: true, errors: [], ir: canonicalizeDocumentIr(input) };
}

function canonicalizeStyle(style) {
    if (!isPlainObject(style)) return undefined;
    const result = {};
    if (style.indent_chars !== undefined) result.indent_chars = clampNumber(style.indent_chars, 0, 0, 20);
    if (style.line_height !== undefined) result.line_height = clampNumber(style.line_height, 1.5, 0.5, 5);
    if (style.space_after_pt !== undefined) result.space_after_pt = clampNumber(style.space_after_pt, 0, 0, 200);
    if (style.align !== undefined) result.align = String(style.align);
    if (isPlainObject(style.font)) {
        const font = {};
        if (style.font.eastAsia !== undefined) font.eastAsia = String(style.font.eastAsia);
        if (style.font.ascii !== undefined) font.ascii = String(style.font.ascii);
        if (style.font.size_pt !== undefined) font.size_pt = clampNumber(style.font.size_pt, 16, 5, 72);
        if (style.font.bold !== undefined) font.bold = Boolean(style.font.bold);
        if (style.font.color !== undefined) font.color = String(style.font.color);
        if (Array.isArray(style.font.family_chain)) font.family_chain = style.font.family_chain.map(String);
        if (Object.keys(font).length) result.font = font;
    }
    return Object.keys(result).length ? result : undefined;
}

function canonicalizeBlock(block) {
    const type = String(block.type);
    if (type === 'heading') {
        const result = { type, level: Number.parseInt(block.level, 10), text: normalizeText(block.text) };
        const style = canonicalizeStyle(block.style);
        if (style) result.style = style;
        return result;
    }
    if (type === 'paragraph') {
        const result = {
            type,
            runs: block.runs.map(run => {
                const item = { text: normalizeText(run.text) };
                if (run.bold !== undefined) item.bold = Boolean(run.bold);
                if (run.italic !== undefined) item.italic = Boolean(run.italic);
                if (run.underline !== undefined) item.underline = Boolean(run.underline);
                if (run.color !== undefined) item.color = String(run.color);
                if (isPlainObject(run.font)) item.font = canonicalizeStyle({ font: run.font })?.font;
                return item;
            })
        };
        const style = canonicalizeStyle(block.style);
        if (style) result.style = style;
        return result;
    }
    if (type === 'table') {
        const result = {
            type,
            header: block.header.map(normalizeText),
            rows: block.rows.map(row => row.map(normalizeText))
        };
        if (Array.isArray(block.widths_pct)) result.widths_pct = block.widths_pct.map(value => clampNumber(value, 0, 0, 100));
        const style = canonicalizeStyle(block.style);
        if (style) result.style = style;
        return result;
    }
    if (type === 'list') {
        const result = { type, ordered: Boolean(block.ordered), items: block.items.map(normalizeText) };
        const style = canonicalizeStyle(block.style);
        if (style) result.style = style;
        return result;
    }
    if (type === 'image') {
        const result = { type, asset_ref: String(block.asset_ref) };
        if (block.width_mm !== undefined) result.width_mm = clampNumber(block.width_mm, 120, 1, 400);
        if (block.height_mm !== undefined) result.height_mm = clampNumber(block.height_mm, 0, 1, 400);
        return result;
    }
    return { type };
}

/** 规范化 IR：补默认值、夹取数值、剔除未声明字段。同一语义输入必须得到同一输出。 */
function canonicalizeDocumentIr(input) {
    const docType = String(input.doc_type);
    const pageDefault = docType === 'official_document' ? OFFICIAL_PAGE_DEFAULT : GENERAL_PAGE_DEFAULT;
    const page = isPlainObject(input.meta?.page) ? input.meta.page : {};
    const marginSource = isPlainObject(page.margin_mm) ? page.margin_mm : {};
    const meta = {
        title: normalizeText(input.meta?.title),
        doc_number: normalizeText(input.meta?.doc_number),
        issuer: normalizeText(input.meta?.issuer),
        issued_at: normalizeText(input.meta?.issued_at),
        security_level: String(input.meta?.security_level || 'internal'),
        page: {
            size: String(page.size || pageDefault.size),
            orientation: String(page.orientation || pageDefault.orientation),
            margin_mm: {
                top: clampNumber(marginSource.top, pageDefault.margin_mm.top, 0, 100),
                bottom: clampNumber(marginSource.bottom, pageDefault.margin_mm.bottom, 0, 100),
                left: clampNumber(marginSource.left, pageDefault.margin_mm.left, 0, 100),
                right: clampNumber(marginSource.right, pageDefault.margin_mm.right, 0, 100)
            }
        }
    };
    ['subtitle', 'recipient', 'signoff'].forEach(field => {
        if (input.meta?.[field] !== undefined) meta[field] = normalizeText(input.meta[field]);
    });
    const footerSource = isPlainObject(input.footer) ? input.footer : {};
    return {
        ir_version: IR_VERSION,
        doc_type: docType,
        meta,
        blocks: input.blocks.map(canonicalizeBlock),
        footer: {
            page_number: footerSource.page_number === undefined ? docType === 'official_document' : Boolean(footerSource.page_number),
            format: String(footerSource.format || '— {page} —')
        }
    };
}

/** IR 摘要：规范化后 canonicalJson 的 sha256，是 rendition 去重键的一部分。 */
function computeIrDigest(ir) {
    return crypto.createHash('sha256').update(canonicalJson(ir)).digest('hex');
}

/** 收集 IR 中引用的全部 CAS 对象 id，供渲染前的授权校验使用。 */
function collectIrAssetRefs(ir) {
    return [...new Set((ir?.blocks || [])
        .filter(block => block?.type === 'image' && block.asset_ref)
        .map(block => String(block.asset_ref)))];
}

module.exports = {
    ALIGNMENTS,
    BLOCK_TYPES,
    CAS_REF_PATTERN,
    DOC_TYPES,
    DOC_TYPE_RULES,
    GENERAL_PAGE_DEFAULT,
    IR_VERSION,
    MAX_BLOCKS,
    MAX_TABLE_CELLS,
    OFFICIAL_PAGE_DEFAULT,
    SECURITY_LEVELS,
    canonicalizeDocumentIr,
    collectIrAssetRefs,
    computeIrDigest,
    validateDocumentIr
};
