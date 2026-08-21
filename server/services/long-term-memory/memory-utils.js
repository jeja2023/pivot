const crypto = require('crypto');

const MEMORY_SETTING_KEY = 'long_term_memory_enabled';
const MEMORY_STATUS = Object.freeze({
    active: 'active',
    deleted: 'deleted',
    disabled: 'disabled'
});
const MEMORY_TYPES = Object.freeze({
    preference: 'preference',
    fact: 'fact',
    decision: 'decision',
    episode: 'episode'
});
const MEMORY_TYPE_LABELS = Object.freeze({
    [MEMORY_TYPES.preference]: '用户偏好',
    [MEMORY_TYPES.fact]: '项目/任务事实',
    [MEMORY_TYPES.decision]: '长期决策',
    [MEMORY_TYPES.episode]: '历史片段'
});

const DEFAULT_RETRIEVAL_BUDGET_RATIO = 0.08;
const MIN_RETRIEVAL_BUDGET_RATIO = 0.05;
const MAX_RETRIEVAL_BUDGET_RATIO = 0.10;
const DEFAULT_MAX_INJECTED_MEMORIES = 8;
const MAX_MEMORY_CONTENT_CHARS = 800;
const MIN_MEMORY_CONTENT_CHARS = 8;
const EXTRACTION_TIMEOUT_MS = Math.max(5000, Number.parseInt(process.env.LONG_TERM_MEMORY_EXTRACTION_TIMEOUT_MS, 10) || 30000);
const MODEL_EXTRACTION_TIMEOUT_MS = Math.max(3000, Number.parseInt(process.env.LONG_TERM_MEMORY_LLM_EXTRACTION_TIMEOUT_MS, 10) || Math.min(EXTRACTION_TIMEOUT_MS, 15000));
const MODEL_EXTRACTION_MAX_OUTPUT_TOKENS = Math.max(128, Math.min(4000, Number.parseInt(process.env.LONG_TERM_MEMORY_LLM_EXTRACTION_MAX_TOKENS, 10) || 800));
const MODEL_EXTRACTION_MAX_CANDIDATES = 8;
const MODEL_EXTRACTION_DISABLED = String(process.env.LONG_TERM_MEMORY_LLM_EXTRACTION || '').toLowerCase() === 'false';
const MEMORY_JOB_STATUS = Object.freeze({
    queued: 'queued',
    running: 'running',
    succeeded: 'succeeded',
    failed: 'failed',
    skipped: 'skipped'
});
const DEFAULT_MEMORY_JOB_MAX_ATTEMPTS = Math.max(1, Number.parseInt(process.env.LONG_TERM_MEMORY_JOB_MAX_ATTEMPTS, 10) || 3);
const MEMORY_JOB_STALE_LOCK_MINUTES = Math.max(1, Number.parseInt(process.env.LONG_TERM_MEMORY_JOB_STALE_LOCK_MINUTES, 10) || 10);
const DEFAULT_COMPLETED_JOB_RETENTION_DAYS = Math.max(1, Number.parseInt(process.env.LONG_TERM_MEMORY_JOB_RETENTION_DAYS, 10) || 30);

const SENSITIVE_PATTERNS = [
    /\b(?:api[_-]?key|secret|token|password|passwd|pwd|密钥|密码|口令|令牌)\b\s*[:：=]/i,
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\b(?:\d[ -]*?){13,19}\b/,
    /\b\d{15}|\d{17}[\dXx]\b/,
    /\b1[3-9]\d{9}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/
];


function clamp(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function normalizeMemoryType(type) {
    const value = String(type || '').trim().toLowerCase();
    return Object.values(MEMORY_TYPES).includes(value) ? value : MEMORY_TYPES.episode;
}

function normalizeMemoryScope(scope) {
    const value = String(scope || '').trim().toLowerCase();
    if (['user', 'project', 'session', 'global'].includes(value)) return value;
    return 'user';
}

function normalizeMemoryContent(content) {
    return String(content || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_MEMORY_CONTENT_CHARS);
}

function normalizeSourceMessageIds(ids = []) {
    const values = Array.isArray(ids) ? ids : [ids];
    return [...new Set(values
        .map(id => Number.parseInt(id, 10))
        .filter(id => Number.isSafeInteger(id) && id > 0))]
        .slice(0, 20);
}

function parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
        return [];
    }
}

function hasSensitiveContent(text) {
    const value = String(text || '');
    return SENSITIVE_PATTERNS.some(pattern => pattern.test(value));
}

function normalizeComparableText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '')
        .slice(0, 160);
}

function fingerprintMemory(type, content) {
    return crypto.createHash('sha256')
        .update(`${normalizeMemoryType(type)}:${normalizeComparableText(content)}`)
        .digest('hex');
}

function contentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            return part.text || part.content || '';
        }).filter(Boolean).join('\n');
    }
    return content ? JSON.stringify(content) : '';
}

function createMemoryValidationError(message, code = 'INVALID_MEMORY') {
    const err = new Error(message);
    err.statusCode = 400;
    err.code = code;
    return err;
}

function normalizeOptionalTimestamp(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const parsed = Date.parse(text.replace(' ', 'T'));
    if (!Number.isFinite(parsed)) return null;
    return text.slice(0, 64);
}


module.exports = {
    MEMORY_SETTING_KEY,
    MEMORY_STATUS,
    MEMORY_TYPES,
    MEMORY_TYPE_LABELS,
    DEFAULT_RETRIEVAL_BUDGET_RATIO,
    MIN_RETRIEVAL_BUDGET_RATIO,
    MAX_RETRIEVAL_BUDGET_RATIO,
    DEFAULT_MAX_INJECTED_MEMORIES,
    MAX_MEMORY_CONTENT_CHARS,
    MIN_MEMORY_CONTENT_CHARS,
    EXTRACTION_TIMEOUT_MS,
    MODEL_EXTRACTION_TIMEOUT_MS,
    MODEL_EXTRACTION_MAX_OUTPUT_TOKENS,
    MODEL_EXTRACTION_MAX_CANDIDATES,
    MODEL_EXTRACTION_DISABLED,
    MEMORY_JOB_STATUS,
    DEFAULT_MEMORY_JOB_MAX_ATTEMPTS,
    MEMORY_JOB_STALE_LOCK_MINUTES,
    DEFAULT_COMPLETED_JOB_RETENTION_DAYS,
    clamp,
    normalizeMemoryType,
    normalizeMemoryScope,
    normalizeMemoryContent,
    normalizeSourceMessageIds,
    parseJsonArray,
    hasSensitiveContent,
    normalizeComparableText,
    fingerprintMemory,
    contentText,
    createMemoryValidationError,
    normalizeOptionalTimestamp
};
