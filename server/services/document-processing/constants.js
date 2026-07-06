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

const DEFAULT_DOCUMENT_PROCESSING_CONFIG = Object.freeze({
    maxRenderPages: Math.max(1, Number.parseInt(process.env.DOCUMENT_PROCESSING_MAX_RENDER_PAGES || '5', 10) || 5),
    maxOcrPages: Math.max(1, Number.parseInt(process.env.DOCUMENT_PROCESSING_MAX_OCR_PAGES || '5', 10) || 5),
    confidenceThreshold: Math.min(Math.max(Number.parseFloat(process.env.DOCUMENT_PROCESSING_CONFIDENCE_THRESHOLD || '0.75') || 0.75, 0), 1),
    ocrTimeoutMs: Math.max(5000, Number.parseInt(process.env.DOCUMENT_PROCESSING_OCR_TIMEOUT_MS || '120000', 10) || 120000),
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
    normalizeJobType
};
