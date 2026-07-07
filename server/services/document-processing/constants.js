const JOB_STATUSES = Object.freeze({
    QUEUED: 'queued',
    PROCESSING: 'processing',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    NEEDS_REVIEW: 'needs_review',
    CANCELLED: 'cancelled'
});

const JOB_TYPES = Object.freeze({
    AUTO: 'auto',
    EXTRACT_TEXT: 'extract_text',
    OCR: 'ocr',
    PDF_TOOL: 'pdf_tool'
});

const OUTPUT_TYPES = Object.freeze({
    TEXT: 'txt',
    MARKDOWN: 'markdown',
    JSON: 'json',
    HTML: 'html',
    DOCX: 'docx',
    SEARCHABLE_PDF: 'searchable_pdf'
});

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const PDF_EXTENSIONS = new Set(['.pdf']);
const TEXT_LIKE_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.html', '.htm']);
const OFFICE_EXTENSIONS = new Set(['.doc', '.docx', '.xls', '.xlsx']);

const DEFAULT_OCR_SERVICE_URL = 'http://ocr-service:9100';

const DOCUMENT_PROCESSING_SETTING_KEYS = Object.freeze({
    engine: 'document_processing_ocr_engine',
    serviceUrl: 'document_processing_ocr_service_url',
    maxRenderPages: 'document_processing_max_render_pages',
    maxOcrPages: 'document_processing_max_ocr_pages',
    confidenceThreshold: 'document_processing_confidence_threshold',
    ocrTimeoutMs: 'document_processing_ocr_timeout_ms',
    maxConcurrentJobs: 'document_processing_max_concurrent_jobs',
    outputRetentionDays: 'document_processing_output_retention_days'
});

function normalizeOcrServiceUrl(value, fallback = DEFAULT_OCR_SERVICE_URL) {
    const raw = String(value || fallback || DEFAULT_OCR_SERVICE_URL).trim();
    let parsed;
    try {
        parsed = new URL(raw);
    } catch (_err) {
        const error = new Error('OCR 服务地址格式不正确');
        error.status = 400;
        throw error;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        const error = new Error('OCR 服务地址仅支持 HTTP 或 HTTPS');
        error.status = 400;
        throw error;
    }
    if (parsed.username || parsed.password) {
        const error = new Error('OCR 服务地址不能包含用户名或密码');
        error.status = 400;
        throw error;
    }
    if (parsed.search || parsed.hash) {
        const error = new Error('OCR 服务地址不能包含查询参数或锚点');
        error.status = 400;
        throw error;
    }
    return parsed.href.replace(/\/+$/, '');
}
const DEFAULT_DOCUMENT_PROCESSING_CONFIG = Object.freeze({
    maxRenderPages: Math.max(1, Number.parseInt(process.env.DOCUMENT_PROCESSING_MAX_RENDER_PAGES || '5', 10) || 5),
    maxOcrPages: Math.max(1, Number.parseInt(process.env.DOCUMENT_PROCESSING_MAX_OCR_PAGES || '5', 10) || 5),
    confidenceThreshold: Math.min(Math.max(Number.parseFloat(process.env.DOCUMENT_PROCESSING_CONFIDENCE_THRESHOLD || '0.75') || 0.75, 0), 1),
    ocrTimeoutMs: Math.max(5000, Number.parseInt(process.env.DOCUMENT_PROCESSING_OCR_TIMEOUT_MS || process.env.OCR_SERVICE_TIMEOUT_MS || '120000', 10) || 120000),
    maxConcurrentJobs: Math.max(1, Number.parseInt(process.env.DOCUMENT_PROCESSING_MAX_CONCURRENT || '2', 10) || 2),
    outputRetentionDays: Math.max(1, Number.parseInt(process.env.DOCUMENT_PROCESSING_OUTPUT_RETENTION_DAYS || '30', 10) || 30)
});

function normalizeJobType(value) {
    const type = String(value || '').trim().toLowerCase();
    if (Object.values(JOB_TYPES).includes(type)) return type;
    if (type === 'extract') return JOB_TYPES.EXTRACT_TEXT;
    return JOB_TYPES.AUTO;
}

function normalizeJobStatus(value) {
    const status = String(value || '').trim().toLowerCase();
    return Object.values(JOB_STATUSES).includes(status) ? status : '';
}

function isImageExtension(ext) {
    return IMAGE_EXTENSIONS.has(String(ext || '').toLowerCase());
}

function isPdfExtension(ext) {
    return PDF_EXTENSIONS.has(String(ext || '').toLowerCase());
}

function isTextExtractableExtension(ext) {
    const value = String(ext || '').toLowerCase();
    return TEXT_LIKE_EXTENSIONS.has(value) || OFFICE_EXTENSIONS.has(value) || PDF_EXTENSIONS.has(value);
}

module.exports = {
    DEFAULT_DOCUMENT_PROCESSING_CONFIG,
    DEFAULT_OCR_SERVICE_URL,
    DOCUMENT_PROCESSING_SETTING_KEYS,
    IMAGE_EXTENSIONS,
    JOB_STATUSES,
    JOB_TYPES,
    OFFICE_EXTENSIONS,
    OUTPUT_TYPES,
    PDF_EXTENSIONS,
    TEXT_LIKE_EXTENSIONS,
    isImageExtension,
    isPdfExtension,
    isTextExtractableExtension,
    normalizeJobStatus,
    normalizeJobType,
    normalizeOcrServiceUrl
};
