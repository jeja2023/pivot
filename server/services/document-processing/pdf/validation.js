const { isImageExtension, isPdfExtension } = require('../constants');

const PDF_TOOL_OPERATIONS = Object.freeze({
    SPLIT: 'split',
    MERGE: 'merge',
    ROTATE: 'rotate',
    DELETE_PAGES: 'delete_pages',
    REORDER: 'reorder',
    EXTRACT_TEXT: 'extract_text',
    PDF_TO_IMAGES: 'pdf_to_images',
    IMAGES_TO_PDF: 'images_to_pdf',
    SEARCHABLE_PDF: 'searchable_pdf',
    WATERMARK: 'watermark',
    PAGE_NUMBERS: 'page_numbers',
    CROP: 'crop',
    INSERT_BLANK: 'insert_blank',
    COMPRESS: 'compress',
    PROTECT: 'protect',
    COMPARE: 'compare',
    REDACT: 'redact',
    FILL_FORM: 'fill_form',
    ANNOTATE: 'annotate',
    PDFA_VALIDATE: 'pdfa_validate',
    EXPORT_DOCX: 'export_docx',
    EXPORT_XLSX: 'export_xlsx'
    ,PAGE_PLAN: 'page_plan'
});

const OPERATION_ALIASES = Object.freeze({
    delete: PDF_TOOL_OPERATIONS.DELETE_PAGES,
    remove_pages: PDF_TOOL_OPERATIONS.DELETE_PAGES,
    'images-to-pdf': PDF_TOOL_OPERATIONS.IMAGES_TO_PDF,
    'pdf-to-images': PDF_TOOL_OPERATIONS.PDF_TO_IMAGES,
    page_numbers: PDF_TOOL_OPERATIONS.PAGE_NUMBERS,
    page_number: PDF_TOOL_OPERATIONS.PAGE_NUMBERS,
    protect_pdf: PDF_TOOL_OPERATIONS.PROTECT,
    compare_pdf: PDF_TOOL_OPERATIONS.COMPARE,
    redact_pdf: PDF_TOOL_OPERATIONS.REDACT,
    fill_form: PDF_TOOL_OPERATIONS.FILL_FORM,
    pdfa: PDF_TOOL_OPERATIONS.PDFA_VALIDATE,
    pdf_a_validate: PDF_TOOL_OPERATIONS.PDFA_VALIDATE,
    pdf_to_word: PDF_TOOL_OPERATIONS.EXPORT_DOCX,
    pdf_to_excel: PDF_TOOL_OPERATIONS.EXPORT_XLSX
    ,organize_pages: PDF_TOOL_OPERATIONS.PAGE_PLAN
});

const PDF_OPERATION_META = Object.freeze({
    [PDF_TOOL_OPERATIONS.MERGE]: { label: '合并 PDF', inputMode: 'combine', accept: 'pdf' },
    [PDF_TOOL_OPERATIONS.IMAGES_TO_PDF]: { label: '图片转 PDF', inputMode: 'combine', accept: 'image' },
    [PDF_TOOL_OPERATIONS.SPLIT]: { label: '拆分页面', inputMode: 'single-or-batch', accept: 'pdf', supportsPages: true },
    [PDF_TOOL_OPERATIONS.ROTATE]: { label: '旋转页面', inputMode: 'single-or-batch', accept: 'pdf', supportsPages: true },
    [PDF_TOOL_OPERATIONS.DELETE_PAGES]: { label: '删除页面', inputMode: 'single-or-batch', accept: 'pdf', supportsPages: true },
    [PDF_TOOL_OPERATIONS.REORDER]: { label: '重排页面', inputMode: 'single-or-batch', accept: 'pdf', supportsOrder: true },
    [PDF_TOOL_OPERATIONS.EXTRACT_TEXT]: { label: '提取文本', inputMode: 'single-or-batch', accept: 'pdf', supportsPages: true },
    [PDF_TOOL_OPERATIONS.PDF_TO_IMAGES]: { label: 'PDF 转图片', inputMode: 'single-or-batch', accept: 'pdf', supportsPages: true, supportsDpi: true },
    [PDF_TOOL_OPERATIONS.SEARCHABLE_PDF]: { label: '生成可搜索 PDF', inputMode: 'single', accept: 'pdf-or-image', supportsPages: true, requiresOcr: true },
    [PDF_TOOL_OPERATIONS.WATERMARK]: { label: '添加水印', inputMode: 'single-or-batch', accept: 'pdf', supportsPages: true, supportsWatermark: true },
    [PDF_TOOL_OPERATIONS.PAGE_NUMBERS]: { label: '添加页码', inputMode: 'single-or-batch', accept: 'pdf', supportsPages: true, supportsPageNumbers: true },
    [PDF_TOOL_OPERATIONS.CROP]: { label: '裁切页面', inputMode: 'single-or-batch', accept: 'pdf', supportsPages: true, supportsCrop: true },
    [PDF_TOOL_OPERATIONS.INSERT_BLANK]: { label: '插入空白页', inputMode: 'single-or-batch', accept: 'pdf', supportsBlankPage: true },
    [PDF_TOOL_OPERATIONS.COMPRESS]: { label: '优化 PDF', inputMode: 'single-or-batch', accept: 'pdf', supportsCompression: true },
    [PDF_TOOL_OPERATIONS.PROTECT]: { label: '加密保护 PDF', inputMode: 'single', accept: 'pdf', requiresQpdf: true, supportsProtection: true },
    [PDF_TOOL_OPERATIONS.COMPARE]: { label: '比较两个 PDF', inputMode: 'exact-two', accept: 'pdf', supportsCompare: true },
    [PDF_TOOL_OPERATIONS.REDACT]: { label: '永久脱敏（栅格化）', inputMode: 'single-or-batch', accept: 'pdf', supportsRedaction: true },
    [PDF_TOOL_OPERATIONS.FILL_FORM]: { label: '填写 PDF 表单', inputMode: 'single-or-batch', accept: 'pdf', supportsFormFill: true },
    [PDF_TOOL_OPERATIONS.ANNOTATE]: { label: '添加轻批注', inputMode: 'single-or-batch', accept: 'pdf', supportsAnnotations: true },
    [PDF_TOOL_OPERATIONS.PDFA_VALIDATE]: { label: '验证 PDF/A', inputMode: 'single', accept: 'pdf', requiresVeraPdf: true, supportsPdfa: true },
    [PDF_TOOL_OPERATIONS.EXPORT_DOCX]: { label: '导出可复核 Word', inputMode: 'single-or-batch', accept: 'pdf', supportsDocxExport: true },
    [PDF_TOOL_OPERATIONS.EXPORT_XLSX]: { label: '导出可复核 Excel', inputMode: 'single-or-batch', accept: 'pdf', supportsXlsxExport: true }
    ,[PDF_TOOL_OPERATIONS.PAGE_PLAN]: { label: '页面工作区编排', inputMode: 'single', accept: 'pdf', supportsPagePlan: true }
});

function operationError(message, code = 'INVALID_OPERATION') {
    const error = new Error(message);
    error.status = 400;
    error.code = code;
    return error;
}

function normalizePdfOperation(value) {
    const operation = String(value || '').trim().toLowerCase();
    const normalized = OPERATION_ALIASES[operation] || operation;
    return Object.prototype.hasOwnProperty.call(PDF_OPERATION_META, normalized) ? normalized : '';
}

function requirePdfOperation(value) {
    const operation = normalizePdfOperation(value);
    if (!operation) throw operationError('不支持的 PDF 操作，请从工具列表中选择后重试。');
    return operation;
}

function getPdfOperationMeta(value) {
    const operation = normalizePdfOperation(value);
    return operation ? PDF_OPERATION_META[operation] : null;
}

function normalizePageLimit(value, fallback = 100) {
    const parsed = Number.parseInt(value, 10);
    return Math.min(Math.max(Number.isFinite(parsed) ? parsed : fallback, 1), 300);
}

function assertPdfPageCount(count, limit) {
    const numeric = Number(count || 0);
    const max = normalizePageLimit(limit);
    if (!Number.isSafeInteger(numeric) || numeric < 1) throw operationError('PDF 未包含可处理的页面。', 'PDF_EMPTY');
    if (numeric > max) throw operationError(`本次处理共 ${numeric} 页，超过 ${max} 页限制。请缩小页面范围或分批处理。`, 'PAGE_LIMIT_EXCEEDED');
    return numeric;
}

function parsePageToken(token, pageCount) {
    const match = String(token || '').match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw operationError(`页面范围“${token}”格式不正确，请使用 1-3,5 这类写法。`, 'INVALID_PAGE_RANGE');
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < 1 || start > pageCount || end > pageCount) {
        throw operationError(`页面范围“${token}”超出文件的 1-${pageCount} 页范围。`, 'INVALID_PAGE_RANGE');
    }
    if (start > end) throw operationError(`页面范围“${token}”的起始页不能大于结束页。`, 'INVALID_PAGE_RANGE');
    return { start, end };
}

function parsePageSelection(value, pageCount, { defaultAll = true, limit = 300 } = {}) {
    const total = assertPdfPageCount(pageCount, 300);
    const text = String(value || '').trim();
    if (!text) {
        if (!defaultAll) return [];
        assertPdfPageCount(total, limit);
        return Array.from({ length: total }, (_item, index) => index);
    }
    const tokens = text.split(/[，,;；\s]+/).filter(Boolean);
    if (!tokens.length) throw operationError('请填写页面范围。', 'INVALID_PAGE_RANGE');
    const indexes = new Set();
    tokens.forEach(token => {
        const { start, end } = parsePageToken(token, total);
        for (let page = start; page <= end; page += 1) indexes.add(page - 1);
    });
    const selected = Array.from(indexes).sort((a, b) => a - b);
    if (!selected.length) throw operationError('未选择到可处理页面。', 'INVALID_PAGE_RANGE');
    assertPdfPageCount(selected.length, limit);
    return selected;
}

function parsePageOrder(value, pageCount, { limit = 300 } = {}) {
    const total = assertPdfPageCount(pageCount, limit);
    const text = String(value || '').trim();
    if (!text) throw operationError(`请按完整顺序填写 ${total} 页，例如 3,1,2。`, 'INVALID_PAGE_ORDER');
    const tokens = text.split(/[，,;；\s]+/).filter(Boolean);
    if (tokens.length !== total) throw operationError(`重排必须包含全部 ${total} 页，当前填写 ${tokens.length} 页。`, 'INVALID_PAGE_ORDER');
    const order = tokens.map(token => {
        if (!/^\d+$/.test(token)) throw operationError(`页面顺序“${token}”不是有效页码。`, 'INVALID_PAGE_ORDER');
        const page = Number(token);
        if (!Number.isSafeInteger(page) || page < 1 || page > total) throw operationError(`页面顺序“${token}”超出 1-${total} 页范围。`, 'INVALID_PAGE_ORDER');
        return page - 1;
    });
    if (new Set(order).size !== total) throw operationError('重排页面不能重复，请填写每一页一次。', 'INVALID_PAGE_ORDER');
    return order;
}

function assertPdfInputFiles({ operation, files = [], mode = '' } = {}) {
    const meta = getPdfOperationMeta(operation);
    if (!meta) throw operationError('不支持的 PDF 操作，请从工具列表中选择后重试。');
    const list = Array.isArray(files) ? files.filter(Boolean) : [];
    if (!list.length) throw operationError('请至少上传一个文件。', 'INPUT_REQUIRED');
    const isBatch = String(mode || '').toLowerCase() === 'batch';
    if (meta.inputMode === 'combine' && list.length < 2) {
        throw operationError(`${meta.label}至少需要两个文件。`, 'UNSUPPORTED_INPUT_COUNT');
    }
    if (meta.inputMode === 'single' && list.length !== 1) {
        throw operationError(`${meta.label}一次只能处理一个文件。`, 'UNSUPPORTED_INPUT_COUNT');
    }
    if (meta.inputMode === 'exact-two' && list.length !== 2) {
        throw operationError(`${meta.label}需要且只能选择两份 PDF。`, 'UNSUPPORTED_INPUT_COUNT');
    }
    if (meta.inputMode === 'single-or-batch' && list.length > 1 && !isBatch) {
        throw operationError(`${meta.label}默认一次只能处理一个文件；如需分别处理多份文件，请选择“批量分别处理”。`, 'UNSUPPORTED_INPUT_COUNT');
    }
    const invalid = list.find(file => {
        if (meta.accept === 'pdf') return !isPdfExtension(file.file_ext || file.fileExt);
        if (meta.accept === 'image') return !isImageExtension(file.file_ext || file.fileExt);
        return !(isPdfExtension(file.file_ext || file.fileExt) || isImageExtension(file.file_ext || file.fileExt));
    });
    if (invalid) throw operationError(`${meta.label}不支持文件“${invalid.original_name || invalid.originalName || '未命名文件'}”的类型。`, 'UNSUPPORTED_FILE_TYPE');
    return { meta, files: list, isBatch };
}

function normalizePdfMode(value) {
    return String(value || '').trim().toLowerCase() === 'batch' ? 'batch' : 'single';
}

module.exports = {
    PDF_OPERATION_META,
    PDF_TOOL_OPERATIONS,
    assertPdfInputFiles,
    assertPdfPageCount,
    getPdfOperationMeta,
    normalizePageLimit,
    normalizePdfMode,
    normalizePdfOperation,
    parsePageOrder,
    parsePageSelection,
    requirePdfOperation
};
