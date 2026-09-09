const { deleteAppSetting, getAppSettingValue, setAppSetting } = require('../app-settings');
const { isPasswordError } = require('../../document-text');
const {
    DEFAULT_DOCUMENT_PROCESSING_CONFIG,
    DEFAULT_OCR_SERVICE_URL,
    DOCUMENT_PROCESSING_SETTING_KEYS,
    normalizeOcrServiceUrl
} = require('./constants');
const { normalizeEngine } = require('./ocr');
const { parseJson } = require('./files');

function settingInt(key, fallback, min, max) {
    const value = Number.parseInt(getAppSettingValue(key), 10);
    const normalized = Number.isFinite(value) ? value : fallback;
    return Math.min(Math.max(normalized, min), max);
}

function settingFloat(key, fallback, min, max) {
    const value = Number.parseFloat(getAppSettingValue(key));
    const normalized = Number.isFinite(value) ? value : fallback;
    return Math.min(Math.max(normalized, min), max);
}

function getDocumentProcessingSettings() {
    return {
        engine: normalizeEngine(getAppSettingValue(DOCUMENT_PROCESSING_SETTING_KEYS.engine) || process.env.DOCUMENT_PROCESSING_OCR_ENGINE || 'http'),
        serviceUrl: normalizeOcrServiceUrl(getAppSettingValue(DOCUMENT_PROCESSING_SETTING_KEYS.serviceUrl) || process.env.OCR_SERVICE_URL || DEFAULT_OCR_SERVICE_URL),
        maxRenderPages: settingInt(DOCUMENT_PROCESSING_SETTING_KEYS.maxRenderPages, DEFAULT_DOCUMENT_PROCESSING_CONFIG.maxRenderPages, 1, 100),
        maxOcrPages: settingInt(DOCUMENT_PROCESSING_SETTING_KEYS.maxOcrPages, DEFAULT_DOCUMENT_PROCESSING_CONFIG.maxOcrPages, 1, 100),
        confidenceThreshold: settingFloat(DOCUMENT_PROCESSING_SETTING_KEYS.confidenceThreshold, DEFAULT_DOCUMENT_PROCESSING_CONFIG.confidenceThreshold, 0, 1),
        ocrTimeoutMs: settingInt(DOCUMENT_PROCESSING_SETTING_KEYS.ocrTimeoutMs, DEFAULT_DOCUMENT_PROCESSING_CONFIG.ocrTimeoutMs, 5000, 600000),
        maxConcurrentJobs: settingInt(DOCUMENT_PROCESSING_SETTING_KEYS.maxConcurrentJobs, DEFAULT_DOCUMENT_PROCESSING_CONFIG.maxConcurrentJobs, 1, 8),
        outputRetentionDays: settingInt(DOCUMENT_PROCESSING_SETTING_KEYS.outputRetentionDays, DEFAULT_DOCUMENT_PROCESSING_CONFIG.outputRetentionDays, 1, 365)
    };
}

function updateDocumentProcessingSettings({ patch = {}, userId = null } = {}) {
    const allowed = {
        engine: value => normalizeEngine(value),
        serviceUrl: value => normalizeOcrServiceUrl(value),
        maxRenderPages: value => Math.min(Math.max(Number.parseInt(value, 10) || DEFAULT_DOCUMENT_PROCESSING_CONFIG.maxRenderPages, 1), 100),
        maxOcrPages: value => Math.min(Math.max(Number.parseInt(value, 10) || DEFAULT_DOCUMENT_PROCESSING_CONFIG.maxOcrPages, 1), 100),
        confidenceThreshold: value => Math.min(Math.max(Number.parseFloat(value) || DEFAULT_DOCUMENT_PROCESSING_CONFIG.confidenceThreshold, 0), 1),
        ocrTimeoutMs: value => Math.min(Math.max(Number.parseInt(value, 10) || DEFAULT_DOCUMENT_PROCESSING_CONFIG.ocrTimeoutMs, 5000), 600000),
        maxConcurrentJobs: value => Math.min(Math.max(Number.parseInt(value, 10) || DEFAULT_DOCUMENT_PROCESSING_CONFIG.maxConcurrentJobs, 1), 8),
        outputRetentionDays: value => Math.min(Math.max(Number.parseInt(value, 10) || DEFAULT_DOCUMENT_PROCESSING_CONFIG.outputRetentionDays, 1), 365)
    };
    Object.entries(allowed).forEach(([name, normalize]) => {
        if (!Object.prototype.hasOwnProperty.call(patch, name)) return;
        const key = DOCUMENT_PROCESSING_SETTING_KEYS[name];
        if (name === 'serviceUrl' && String(patch[name] ?? '').trim() === '') {
            deleteAppSetting(key);
            return;
        }
        setAppSetting(key, normalize(patch[name]), { updatedBy: userId });
    });
    return getDocumentProcessingSettings();
}

function getMaxConcurrentJobs() {
    return getDocumentProcessingSettings().maxConcurrentJobs;
}

function safeJson(value, fallback = {}) {
    try {
        return JSON.stringify(value && typeof value === 'object' ? value : fallback);
    } catch (_err) {
        return JSON.stringify(fallback);
    }
}

function sanitizeErrorMessage(error) {
    if (isPasswordError(error)) return '文件已加密或需要密码，请提供密码后重试。';
    return String(error?.message || error || '文档处理失败')
        .replace(/[A-Z]:\\[^\s]+/g, '[受控路径]')
        .replace(/\/[^\s]+/g, '[受控路径]')
        .split('\n')[0]
        .slice(0, 500);
}

function normalizeConfig(config = {}) {
    const safe = config && typeof config === 'object' ? config : {};
    const defaults = getDocumentProcessingSettings();
    const requestedRenderPages = Number.parseInt(safe.maxRenderPages, 10);
    const requestedOcrPages = Number.parseInt(safe.maxOcrPages, 10);
    const requestedConfidence = Number.parseFloat(safe.confidenceThreshold);
    const requestedTimeoutMs = Number.parseInt(safe.timeoutMs, 10);
    return {
        language: String(safe.language || safe.lang || 'ch').slice(0, 24),
        engine: normalizeEngine(safe.engine || defaults.engine || 'http'),
        dpi: Math.min(Math.max(Number.parseInt(safe.dpi, 10) || 220, 72), 600),
        maxRenderPages: Math.min(Math.max(Number.isFinite(requestedRenderPages) ? requestedRenderPages : defaults.maxRenderPages, 1), defaults.maxRenderPages),
        maxOcrPages: Math.min(Math.max(Number.isFinite(requestedOcrPages) ? requestedOcrPages : defaults.maxOcrPages, 1), defaults.maxOcrPages),
        confidenceThreshold: Math.min(Math.max(Number.isFinite(requestedConfidence) ? requestedConfidence : defaults.confidenceThreshold, 0), 1),
        timeoutMs: Math.min(Math.max(Number.isFinite(requestedTimeoutMs) ? requestedTimeoutMs : defaults.ocrTimeoutMs, 5000), 600000),
        password: String(safe.password || '').slice(0, 200),
        operation: String(safe.operation || safe.pdfOperation || '').slice(0, 40),
        pages: String(safe.pages || safe.pageRanges || '').slice(0, 500),
        pageRanges: String(safe.pageRanges || safe.pages || '').slice(0, 500),
        pageOrder: String(safe.pageOrder || '').slice(0, 500),
        rotateDegrees: Number.parseInt(safe.rotateDegrees, 10) || 90,
        maxToolPages: Math.min(Math.max(Number.parseInt(safe.maxToolPages, 10) || 100, 1), 300),
        sourceFileIds: Array.isArray(safe.sourceFileIds)
            ? safe.sourceFileIds.map(id => Number.parseInt(id, 10)).filter(id => Number.isSafeInteger(id) && id > 0).slice(0, 50)
            : []
    };
}

function serializeJob(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        fileId: row.file_id,
        jobType: row.job_type,
        status: row.status,
        progress: Number(row.progress || 0),
        errorMessage: row.error_message || '',
        config: parseJson(row.config_json, {}),
        result: parseJson(row.result_json, {}),
        attempts: Number(row.attempts || 0),
        maxAttempts: Number(row.max_attempts || 0),
        sourceModule: row.source_module || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at || ''
    };
}

function serializePage(row) {
    return {
        id: row.id,
        fileId: row.file_id,
        jobId: row.job_id,
        pageNumber: Number(row.page_number || 1),
        width: Number(row.width || 0),
        height: Number(row.height || 0),
        hasImage: Boolean(row.image_path),
        text: row.text || '',
        textLength: Number(row.text_length || 0),
        ocrStatus: row.ocr_status || '',
        confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
        updatedAt: row.updated_at
    };
}

function serializeBlock(row) {
    return {
        id: row.id,
        pageId: row.page_id,
        pageNumber: Number(row.page_number || 1),
        sortOrder: Number(row.sort_order || 0),
        blockType: row.block_type || 'line',
        text: row.text || '',
        bbox: parseJson(row.bbox_json, []),
        confidence: Number(row.confidence || 0),
        language: row.language || '',
        engine: row.engine || ''
    };
}

module.exports = {
    getDocumentProcessingSettings,
    getMaxConcurrentJobs,
    normalizeConfig,
    safeJson,
    sanitizeErrorMessage,
    serializeBlock,
    serializeJob,
    serializePage,
    updateDocumentProcessingSettings
};
