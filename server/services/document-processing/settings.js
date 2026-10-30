const { getAppSettingValue, refreshAppSettingsCache } = require('../app-settings');
const { transaction } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
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

async function updateDocumentProcessingSettings({ patch = {}, userId = null } = {}) {
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
    const updates = Object.entries(allowed).flatMap(([name, normalize]) => {
        if (!Object.prototype.hasOwnProperty.call(patch, name)) return [];
        const key = DOCUMENT_PROCESSING_SETTING_KEYS[name];
        if (name === 'serviceUrl' && String(patch[name] ?? '').trim() === '') {
            return [{ key, remove: true }];
        }
        return [{ key, value: String(normalize(patch[name])) }];
    });
    if (updates.length) {
        await transaction(async trx => {
            for (const item of updates) {
                if (item.remove) await trx.execute('DELETE FROM app_settings WHERE key = ?', [item.key]);
                else await trx.execute(`INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
                [item.key, item.value, getBeijingTimestamp(), userId]);
            }
        });
        await refreshAppSettingsCache();
    }
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
    const pageSize = ['original', 'a4', 'a3', 'letter'].includes(String(safe.pageSize || '').toLowerCase())
        ? String(safe.pageSize).toLowerCase()
        : 'original';
    const validPositions = new Set(['top-left', 'top-center', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right']);
    const watermarkPosition = validPositions.has(String(safe.watermarkPosition || '').toLowerCase()) ? String(safe.watermarkPosition).toLowerCase() : 'center';
    const pageNumberPosition = validPositions.has(String(safe.pageNumberPosition || '').toLowerCase()) ? String(safe.pageNumberPosition).toLowerCase() : 'bottom-center';
    const asObject = (value, fallback = {}) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
        if (typeof value === 'string' && value.length <= 200_000) return parseJson(value, fallback);
        return fallback;
    };
    const asArray = (value, limit = 100) => {
        const source = Array.isArray(value) ? value : (typeof value === 'string' && value.length <= 200_000 ? parseJson(value, []) : []);
        return Array.isArray(source) ? source.slice(0, limit) : [];
    };
    const redactRegions = asArray(safe.redactRegions, 100).map(region => ({
        page: Math.max(1, Math.min(Number.parseInt(region?.page, 10) || 1, 300)),
        x: Math.max(0, Math.min(Number(region?.x || 0), 1)),
        y: Math.max(0, Math.min(Number(region?.y || 0), 1)),
        width: Math.max(0, Math.min(Number(region?.width || 0), 1)),
        height: Math.max(0, Math.min(Number(region?.height || 0), 1)),
        label: String(region?.label || '').slice(0, 80)
    })).filter(region => region.width > 0 && region.height > 0);
    const annotations = asArray(safe.annotations, 100).map(annotation => ({
        page: Math.max(1, Math.min(Number.parseInt(annotation?.page, 10) || 1, 300)),
        type: ['highlight', 'note'].includes(String(annotation?.type || '').toLowerCase()) ? String(annotation.type).toLowerCase() : 'highlight',
        x: Math.max(0, Math.min(Number(annotation?.x || 0), 1)),
        y: Math.max(0, Math.min(Number(annotation?.y || 0), 1)),
        width: Math.max(0, Math.min(Number(annotation?.width || 0), 1)),
        height: Math.max(0, Math.min(Number(annotation?.height || 0), 1)),
        content: String(annotation?.content || '').slice(0, 2000)
    })).filter(annotation => annotation.width > 0 && annotation.height > 0);
    const pagePlan = asArray(safe.pagePlan, 400).map(item => ({
        sourcePage: Math.max(0, Math.min(Number.parseInt(item?.sourcePage, 10) || 0, 300)),
        rotation: [0, 90, 180, 270].includes(Number(item?.rotation)) ? Number(item.rotation) : 0,
        blank: Boolean(item?.blank),
        width: Math.min(Math.max(Number(item?.width || 0), 0), 2000),
        height: Math.min(Math.max(Number(item?.height || 0), 0), 2000)
    })).filter(item => item.blank || item.sourcePage > 0);
    const outputPermissions = asObject(safe.outputPermissions, {});
    return {
        configVersion: 3,
        language: String(safe.language || safe.lang || 'ch').slice(0, 24),
        engine: normalizeEngine(safe.engine || defaults.engine || 'http'),
        dpi: Math.min(Math.max(Number.parseInt(safe.dpi, 10) || 220, 72), 600),
        maxRenderPages: Math.min(Math.max(Number.isFinite(requestedRenderPages) ? requestedRenderPages : defaults.maxRenderPages, 1), defaults.maxRenderPages),
        maxOcrPages: Math.min(Math.max(Number.isFinite(requestedOcrPages) ? requestedOcrPages : defaults.maxOcrPages, 1), defaults.maxOcrPages),
        confidenceThreshold: Math.min(Math.max(Number.isFinite(requestedConfidence) ? requestedConfidence : defaults.confidenceThreshold, 0), 1),
        timeoutMs: Math.min(Math.max(Number.isFinite(requestedTimeoutMs) ? requestedTimeoutMs : defaults.ocrTimeoutMs, 5000), 600000),
        operation: String(safe.operation || safe.pdfOperation || '').slice(0, 40),
        mode: String(safe.mode || '').toLowerCase() === 'batch' ? 'batch' : 'single',
        requiresPassword: Boolean(String(safe.password || '').trim() || safe.requiresPassword),
        pages: String(safe.pages || safe.pageRanges || '').slice(0, 500),
        pageRanges: String(safe.pageRanges || safe.pages || '').slice(0, 500),
        pageOrder: String(safe.pageOrder || '').slice(0, 500),
        rotateDegrees: Number.parseInt(safe.rotateDegrees, 10) || 90,
        maxToolPages: Math.min(Math.max(Number.parseInt(safe.maxToolPages, 10) || 100, 1), 300),
        watermarkText: String(safe.watermarkText || '').slice(0, 120),
        watermarkPosition,
        watermarkFontSize: Math.min(Math.max(Number(safe.watermarkFontSize || 36), 8), 144),
        watermarkOpacity: Math.min(Math.max(Number(safe.watermarkOpacity ?? 0.18), 0.05), 0.8),
        watermarkRotate: Math.min(Math.max(Number(safe.watermarkRotate ?? -45), -180), 180),
        watermarkMargin: Math.min(Math.max(Number(safe.watermarkMargin || 36), 0), 300),
        pageNumberPosition,
        pageNumberStart: Math.max(Number.parseInt(safe.pageNumberStart, 10) || 1, 1),
        pageNumberPrefix: String(safe.pageNumberPrefix || '').slice(0, 40),
        pageNumberSuffix: String(safe.pageNumberSuffix || '').slice(0, 40),
        pageNumberFontSize: Math.min(Math.max(Number(safe.pageNumberFontSize || 10), 6), 36),
        pageNumberMargin: Math.min(Math.max(Number(safe.pageNumberMargin || 28), 0), 300),
        skipCover: safe.skipCover === true || String(safe.skipCover || '').toLowerCase() === 'true',
        cropLeft: Math.min(Math.max(Number(safe.cropLeft || 0), 0), 10000),
        cropRight: Math.min(Math.max(Number(safe.cropRight || 0), 0), 10000),
        cropTop: Math.min(Math.max(Number(safe.cropTop || 0), 0), 10000),
        cropBottom: Math.min(Math.max(Number(safe.cropBottom || 0), 0), 10000),
        blankPageAfter: Math.min(Math.max(Number.parseInt(safe.blankPageAfter, 10) || 0, 0), 300),
        blankPageCount: Math.min(Math.max(Number.parseInt(safe.blankPageCount, 10) || 1, 1), 20),
        pageSize,
        imageFit: String(safe.imageFit || '').toLowerCase() === 'cover' ? 'cover' : 'contain',
        imageDpi: Math.min(Math.max(Number.parseInt(safe.imageDpi, 10) || 220, 72), 600),
        pageMargin: Math.min(Math.max(Number(safe.pageMargin || 24), 0), 200),
        compressionMode: ['structure', 'images'].includes(String(safe.compressionMode || '').toLowerCase()) ? String(safe.compressionMode).toLowerCase() : 'structure',
        compressionJpegQuality: Math.min(Math.max(Number.parseInt(safe.compressionJpegQuality, 10) || 75, 1), 100),
        redactRegions,
        annotations,
        formValues: asObject(safe.formValues, {}),
        pdfaProfile: ['0', '1a', '1b', '2a', '2b', '2u', '3a', '3b', '3u', '4', '4e', '4f'].includes(String(safe.pdfaProfile || '0').toLowerCase()) ? String(safe.pdfaProfile || '0').toLowerCase() : '0',
        compareDpi: Math.min(Math.max(Number.parseInt(safe.compareDpi, 10) || 144, 72), 300),
        replaceText: asArray(safe.replaceText, 50).map(item => ({
            find: String(item?.find || '').slice(0, 200),
            replace: String(item?.replace || '').slice(0, 200)
        })).filter(item => item.find),
        pagePlan,
        outputPermissions: {
            print: outputPermissions.print !== false,
            modify: outputPermissions.modify !== false
        },
        requiresOutputPassword: Boolean(String(safe.outputPassword || '').trim() || safe.requiresOutputPassword),
        requiresOwnerPassword: Boolean(String(safe.ownerPassword || '').trim() || safe.requiresOwnerPassword),
        sourceFileIds: Array.isArray(safe.sourceFileIds)
            ? safe.sourceFileIds.map(id => Number.parseInt(id, 10)).filter(id => Number.isSafeInteger(id) && id > 0).slice(0, 50)
            : []
    };
}

function publicConfig(config) {
    const safe = config && typeof config === 'object' ? { ...config } : {};
    delete safe.password;
    delete safe.secretRef;
    delete safe.secret_ref;
    delete safe.outputPassword;
    delete safe.ownerPassword;
    delete safe.certificatePassword;
    return safe;
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
        config: publicConfig(parseJson(row.config_json, {})),
        result: parseJson(row.result_json, {}),
        attempts: Number(row.attempts || 0),
        maxAttempts: Number(row.max_attempts || 0),
        sourceModule: row.source_module || '',
        stage: row.stage || '',
        configVersion: Number(row.config_version || 1),
        parentJobId: row.parent_job_id || null,
        sourcePageCount: Number(row.source_page_count || 0),
        plannedPageCount: Number(row.planned_page_count || 0),
        processedPageCount: Number(row.processed_page_count || 0),
        failedPageCount: Number(row.failed_page_count || 0),
        omittedPages: parseJson(row.omitted_pages_json, []),
        coverageComplete: Boolean(row.coverage_complete),
        contentRevision: Math.max(Number(row.content_revision || 1), 1),
        reviewState: row.review_state || 'not_required',
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
        rawText: row.raw_text || row.text || '',
        contentRevision: Math.max(Number(row.content_revision || 1), 1),
        alignmentStatus: row.alignment_status || 'aligned',
        processingState: row.processing_state || row.ocr_status || '',
        result: parseJson(row.result_json, {}),
        pixelWidth: Number(row.pixel_width || row.width || 0),
        pixelHeight: Number(row.pixel_height || row.height || 0),
        pdfWidth: Number(row.pdf_width || 0),
        pdfHeight: Number(row.pdf_height || 0),
        rotation: Number(row.rotation || 0),
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
        text: row.effective_text || row.text || '',
        rawText: row.raw_text || row.text || '',
        effectiveText: row.effective_text || row.text || '',
        stableKey: row.stable_key || '',
        bbox: parseJson(row.bbox_json, []),
        confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
        confidenceSource: row.confidence_source || 'engine',
        alignmentStatus: row.alignment_status || 'aligned',
        resultRevision: Math.max(Number(row.result_revision || 1), 1),
        language: row.language || '',
        engine: row.engine || ''
    };
}

module.exports = {
    getDocumentProcessingSettings,
    getMaxConcurrentJobs,
    normalizeConfig,
    publicConfig,
    safeJson,
    sanitizeErrorMessage,
    serializeBlock,
    serializeJob,
    serializePage,
    updateDocumentProcessingSettings
};
