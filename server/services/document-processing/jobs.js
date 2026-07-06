const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { db } = require('../../db');
const { extractDocumentText, isPasswordError, truncateExtractedText } = require('../../document-text');
const { logger } = require('../../logger');
const { getBeijingTimestamp } = require('../../time');
const { getAppSettingValue, setAppSetting } = require('../app-settings');
const { createKnowledgeDocumentFromUpload, scheduleKnowledgeDocumentIndexing } = require('../rag-documents');
const { createRegulationDocumentFromUpload } = require('../regulations');
const { getKnowledgeLimits } = require('../resource-limits');
const {
    DEFAULT_DOCUMENT_PROCESSING_CONFIG,
    JOB_STATUSES,
    JOB_TYPES,
    OUTPUT_TYPES,
    isImageExtension,
    isPdfExtension,
    isTextExtractableExtension,
    normalizeJobStatus,
    normalizeJobType
} = require('./constants');
const {
    getDocumentFileForUser,
    getDocumentFilePath,
    parseJson,
    registerUploadedFile,
    serializeFile,
    updateDocumentFileMetadata
} = require('./files');
const { createTextOutputs, pagesToText, serializeOutput } = require('./exporters');
const { imageFileToPage, renderPdfPagesToFiles } = require('./renderers');
const { recognizePage } = require('./ocr');
const { PDF_TOOL_OPERATIONS, createSearchablePdfOutput, normalizePdfOperation, processPdfToolOperation } = require('./pdf');
const { buildManagedPath, resolveStoredDocumentPath, safeUnlinkManaged, tempRoot } = require('./paths');

const queue = [];
const runningJobs = new Set();
let runningCount = 0;

const DOCUMENT_PROCESSING_SETTING_KEYS = Object.freeze({
    engine: 'document_processing_ocr_engine',
    maxRenderPages: 'document_processing_max_render_pages',
    maxOcrPages: 'document_processing_max_ocr_pages',
    confidenceThreshold: 'document_processing_confidence_threshold',
    ocrTimeoutMs: 'document_processing_ocr_timeout_ms',
    maxConcurrentJobs: 'document_processing_max_concurrent_jobs',
    outputRetentionDays: 'document_processing_output_retention_days'
});

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
        engine: String(getAppSettingValue(DOCUMENT_PROCESSING_SETTING_KEYS.engine) || process.env.DOCUMENT_PROCESSING_OCR_ENGINE || 'paddle').slice(0, 32),
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
        engine: value => String(value || 'paddle').slice(0, 32),
        maxRenderPages: value => Math.min(Math.max(Number.parseInt(value, 10) || DEFAULT_DOCUMENT_PROCESSING_CONFIG.maxRenderPages, 1), 100),
        maxOcrPages: value => Math.min(Math.max(Number.parseInt(value, 10) || DEFAULT_DOCUMENT_PROCESSING_CONFIG.maxOcrPages, 1), 100),
        confidenceThreshold: value => Math.min(Math.max(Number.parseFloat(value) || DEFAULT_DOCUMENT_PROCESSING_CONFIG.confidenceThreshold, 0), 1),
        ocrTimeoutMs: value => Math.min(Math.max(Number.parseInt(value, 10) || DEFAULT_DOCUMENT_PROCESSING_CONFIG.ocrTimeoutMs, 5000), 600000),
        maxConcurrentJobs: value => Math.min(Math.max(Number.parseInt(value, 10) || DEFAULT_DOCUMENT_PROCESSING_CONFIG.maxConcurrentJobs, 1), 8),
        outputRetentionDays: value => Math.min(Math.max(Number.parseInt(value, 10) || DEFAULT_DOCUMENT_PROCESSING_CONFIG.outputRetentionDays, 1), 365)
    };
    Object.entries(allowed).forEach(([name, normalize]) => {
        if (!Object.prototype.hasOwnProperty.call(patch, name)) return;
        setAppSetting(DOCUMENT_PROCESSING_SETTING_KEYS[name], normalize(patch[name]), { updatedBy: userId });
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
    return {
        language: String(safe.language || safe.lang || 'ch').slice(0, 24),
        engine: String(safe.engine || defaults.engine || 'paddle').slice(0, 32),
        dpi: Math.min(Math.max(Number.parseInt(safe.dpi, 10) || 220, 72), 600),
        maxRenderPages: Math.min(Math.max(Number.parseInt(safe.maxRenderPages, 10) || defaults.maxRenderPages, 1), 100),
        maxOcrPages: Math.min(Math.max(Number.parseInt(safe.maxOcrPages, 10) || defaults.maxOcrPages, 1), 100),
        confidenceThreshold: Math.min(Math.max(Number.parseFloat(safe.confidenceThreshold) || defaults.confidenceThreshold, 0), 1),
        timeoutMs: Math.max(5000, Number.parseInt(safe.timeoutMs, 10) || defaults.ocrTimeoutMs),
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

function getJobRow(jobId, userId = null) {
    const id = Number.parseInt(jobId, 10);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    if (userId) {
        return db.prepare('SELECT * FROM document_jobs WHERE id = ? AND user_id = ?').get(id, userId) || null;
    }
    return db.prepare('SELECT * FROM document_jobs WHERE id = ?').get(id) || null;
}

function getOutputRow(outputId, userId) {
    const id = Number.parseInt(outputId, 10);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return db.prepare(`
        SELECT *
        FROM document_outputs
        WHERE id = ? AND user_id = ? AND status = 'ready'
    `).get(id, userId) || null;
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

function setJobStatus(jobId, status, patch = {}) {
    const now = getBeijingTimestamp();
    const current = getJobRow(jobId);
    if (!current) return null;
    const result = patch.result === undefined ? parseJson(current.result_json, {}) : patch.result;
    const progress = patch.progress === undefined ? current.progress : Math.max(0, Math.min(Number(patch.progress) || 0, 100));
    const errorMessage = patch.errorMessage === undefined ? current.error_message : String(patch.errorMessage || '').slice(0, 500);
    const completedAt = [JOB_STATUSES.SUCCEEDED, JOB_STATUSES.FAILED, JOB_STATUSES.NEEDS_REVIEW, JOB_STATUSES.CANCELLED].includes(status)
        ? (patch.completedAt || now)
        : current.completed_at;
    const cancelledAt = status === JOB_STATUSES.CANCELLED ? (patch.cancelledAt || now) : current.cancelled_at;
    db.prepare(`
        UPDATE document_jobs
        SET status = ?, progress = ?, error_message = ?, result_json = ?, updated_at = ?, completed_at = ?, cancelled_at = ?
        WHERE id = ?
    `).run(status, progress, errorMessage, safeJson(result), now, completedAt, cancelledAt, jobId);
    return getJobRow(jobId);
}

function isCancelled(jobId) {
    const row = getJobRow(jobId);
    return !row || row.status === JOB_STATUSES.CANCELLED;
}

function touchProgress(jobId, progress, resultPatch = null) {
    const row = getJobRow(jobId);
    if (!row || row.status === JOB_STATUSES.CANCELLED) return null;
    const result = resultPatch ? { ...parseJson(row.result_json, {}), ...resultPatch } : parseJson(row.result_json, {});
    return setJobStatus(jobId, JOB_STATUSES.PROCESSING, { progress, result });
}

function insertPage({ userId, fileId, jobId, pageNumber, width = 0, height = 0, imagePath = '', text = '', ocrStatus = 'pending', confidence = null }) {
    const now = getBeijingTimestamp();
    const info = db.prepare(`
        INSERT INTO document_pages (
            user_id, file_id, job_id, page_number, width, height, image_path, text, text_length, ocr_status, confidence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, fileId, jobId, pageNumber, width, height, imagePath, text, String(text || '').length, ocrStatus, confidence, now, now);
    return db.prepare('SELECT * FROM document_pages WHERE id = ?').get(info.lastInsertRowid);
}

function updatePageText({ pageId, text, ocrStatus, confidence }) {
    db.prepare(`
        UPDATE document_pages
        SET text = ?, text_length = ?, ocr_status = ?, confidence = ?, updated_at = ?
        WHERE id = ?
    `).run(String(text || ''), String(text || '').length, ocrStatus, confidence, getBeijingTimestamp(), pageId);
    return db.prepare('SELECT * FROM document_pages WHERE id = ?').get(pageId);
}

function insertOcrBlocks({ userId, fileId, jobId, pageId, pageNumber, blocks = [] }) {
    const now = getBeijingTimestamp();
    const insert = db.prepare(`
        INSERT INTO document_ocr_blocks (
            user_id, file_id, job_id, page_id, page_number, sort_order, block_type, text, bbox_json, confidence, language, engine, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const write = db.transaction(() => {
        blocks.forEach((block, index) => {
            insert.run(
                userId,
                fileId,
                jobId,
                pageId,
                pageNumber,
                Number(block.sortOrder ?? index),
                block.blockType || 'line',
                String(block.text || '').trim(),
                safeJson(block.bbox || []),
                Number(block.confidence || 0),
                block.language || '',
                block.engine || '',
                now,
                now
            );
        });
    });
    write();
}

function getPages(jobId) {
    return db.prepare('SELECT * FROM document_pages WHERE job_id = ? ORDER BY page_number ASC, id ASC').all(jobId);
}

function getBlocks(jobId) {
    return db.prepare('SELECT * FROM document_ocr_blocks WHERE job_id = ? ORDER BY page_number ASC, sort_order ASC, id ASC').all(jobId);
}

function getOutputs(jobId) {
    return db.prepare('SELECT * FROM document_outputs WHERE job_id = ? AND status = ? ORDER BY created_at DESC, id DESC').all(jobId, 'ready');
}

function getReviews(jobId) {
    return db.prepare('SELECT * FROM document_reviews WHERE job_id = ? ORDER BY updated_at DESC, id DESC').all(jobId);
}

function cleanupJobArtifacts(jobId) {
    const outputs = db.prepare('SELECT file_path FROM document_outputs WHERE job_id = ?').all(jobId);
    const pages = db.prepare('SELECT image_path FROM document_pages WHERE job_id = ?').all(jobId);
    outputs.forEach(row => safeUnlinkManaged(row.file_path));
    pages.forEach(row => {
        if (String(row.image_path || '').includes('/pages/')) safeUnlinkManaged(row.image_path);
    });
    db.prepare('DELETE FROM document_outputs WHERE job_id = ?').run(jobId);
    db.prepare('DELETE FROM document_ocr_blocks WHERE job_id = ?').run(jobId);
    db.prepare('DELETE FROM document_reviews WHERE job_id = ?').run(jobId);
    db.prepare('DELETE FROM document_pages WHERE job_id = ?').run(jobId);
}

function enqueueJob(jobId) {
    const id = Number.parseInt(jobId, 10);
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    if (!queue.includes(id) && !runningJobs.has(id)) queue.push(id);
    drainQueue();
    return true;
}

function drainQueue() {
    while (runningCount < getMaxConcurrentJobs() && queue.length > 0) {
        const jobId = queue.shift();
        const row = getJobRow(jobId);
        if (!row || row.status !== JOB_STATUSES.QUEUED) continue;
        runningCount += 1;
        runningJobs.add(jobId);
        setImmediate(async () => {
            try {
                await processJob(jobId);
            } catch (err) {
                logger.error({ err: sanitizeErrorMessage(err), jobId }, '文档处理任务执行失败');
            } finally {
                runningJobs.delete(jobId);
                runningCount = Math.max(0, runningCount - 1);
                drainQueue();
            }
        });
    }
}

function createJobRecord({ userId, fileId, jobType, sourceModule, config }) {
    const now = getBeijingTimestamp();
    const info = db.prepare(`
        INSERT INTO document_jobs (
            user_id, file_id, job_type, status, progress, config_json, result_json, attempts, max_attempts, source_module, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, fileId, normalizeJobType(jobType), JOB_STATUSES.QUEUED, 0, safeJson(normalizeConfig(config)), '{}', 0, 3, sourceModule, now, now);
    return getJobRow(info.lastInsertRowid, userId);
}

async function createJobFromUpload({ user, file, jobType = JOB_TYPES.AUTO, sourceModule = 'document_processing', sourceRef = '', config = {} }) {
    const registeredFile = await registerUploadedFile({ user, file, sourceModule, sourceRef, metadata: { createdBy: sourceModule } });
    const job = createJobRecord({ userId: user.id, fileId: registeredFile.id, jobType, sourceModule, config });
    enqueueJob(job.id);
    return getJobDetail({ userId: user.id, jobId: job.id });
}

async function createPdfToolJobFromUploads({ user, files = [], operation, sourceRef = '', config = {} }) {
    const uploadFiles = Array.isArray(files) ? files.filter(Boolean) : [files].filter(Boolean);
    if (!uploadFiles.length) {
        const error = new Error('请上传需要处理的 PDF 或图片文件。');
        error.status = 400;
        throw error;
    }
    const registeredFiles = [];
    for (const file of uploadFiles.slice(0, 20)) {
        registeredFiles.push(await registerUploadedFile({
            user,
            file,
            sourceModule: 'pdf_tools',
            sourceRef,
            metadata: { createdBy: 'pdf_tools' }
        }));
    }
    const firstFile = registeredFiles[0];
    const job = createJobRecord({
        userId: user.id,
        fileId: firstFile.id,
        jobType: JOB_TYPES.PDF_TOOL,
        sourceModule: 'pdf_tools',
        config: {
            ...config,
            operation,
            sourceFileIds: registeredFiles.map(item => item.id)
        }
    });
    enqueueJob(job.id);
    return getJobDetail({ userId: user.id, jobId: job.id });
}

function listJobs({ userId, page = 1, limit = 15, status = '', jobType = '', sourceModule = '' }) {
    const safePage = Math.max(Number.parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 15, 1), 100);
    const filters = ['j.user_id = ?'];
    const params = [userId];
    const normalizedStatus = normalizeJobStatus(status);
    if (normalizedStatus) {
        filters.push('j.status = ?');
        params.push(normalizedStatus);
    }
    const normalizedType = normalizeJobType(jobType);
    if (jobType && normalizedType) {
        filters.push('j.job_type = ?');
        params.push(normalizedType);
    }
    if (sourceModule) {
        filters.push('j.source_module = ?');
        params.push(String(sourceModule).slice(0, 80));
    }
    const whereSql = filters.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) AS count FROM document_jobs j WHERE ${whereSql}`).get(...params).count;
    const rows = db.prepare(`
        SELECT j.*, f.original_name, f.file_type, f.file_ext, f.file_size, f.page_count
        FROM document_jobs j
        JOIN document_files f ON f.id = j.file_id
        WHERE ${whereSql}
        ORDER BY j.created_at DESC, j.id DESC
        LIMIT ? OFFSET ?
    `).all(...params, safeLimit, (safePage - 1) * safeLimit);
    return {
        data: rows.map(row => ({
            ...serializeJob(row),
            file: {
                originalName: row.original_name,
                fileType: row.file_type,
                fileExt: row.file_ext,
                fileSize: Number(row.file_size || 0),
                pageCount: Number(row.page_count || 0)
            }
        })),
        total,
        page: safePage,
        limit: safeLimit,
        queue: getQueueStatus()
    };
}

function getJobDetail({ userId, jobId }) {
    const job = getJobRow(jobId, userId);
    if (!job) return null;
    const file = getDocumentFileForUser(job.file_id, userId);
    const pages = getPages(job.id);
    const blocks = getBlocks(job.id);
    return {
        job: serializeJob(job),
        file: serializeFile(file),
        pages: pages.map(serializePage),
        blocks: blocks.map(serializeBlock),
        outputs: getOutputs(job.id).map(serializeOutput),
        reviews: getReviews(job.id).map(row => ({
            id: row.id,
            pageId: row.page_id,
            reviewStatus: row.review_status,
            revisedText: row.revised_text,
            lowConfidenceConfirmed: Boolean(row.low_confidence_confirmed),
            reviewedAt: row.reviewed_at,
            updatedAt: row.updated_at
        }))
    };
}

async function preparePagesForJob({ job, file, filePath, config }) {
    const userId = job.user_id;
    const ext = file.file_ext;
    if (isImageExtension(ext)) {
        const page = await imageFileToPage({ filePath, relativePath: file.file_path, pageNumber: 1 });
        const row = insertPage({ userId, fileId: file.id, jobId: job.id, ...page, ocrStatus: job.job_type === JOB_TYPES.OCR ? 'processing' : 'pending' });
        updateDocumentFileMetadata({ fileId: file.id, userId, pageCount: 1, metadata: { image: { width: page.width, height: page.height } } });
        return [row];
    }
    if (isPdfExtension(ext)) {
        const rendered = await renderPdfPagesToFiles({
            filePath,
            userId,
            jobId: job.id,
            options: { password: config.password, maxPages: config.maxRenderPages, desiredWidth: Math.round(config.dpi * 6.4) }
        });
        const rows = rendered.map(page => insertPage({
            userId,
            fileId: file.id,
            jobId: job.id,
            pageNumber: page.pageNumber,
            width: page.width,
            height: page.height,
            imagePath: page.imagePath,
            ocrStatus: job.job_type === JOB_TYPES.OCR ? 'processing' : 'pending'
        }));
        updateDocumentFileMetadata({ fileId: file.id, userId, pageCount: rows.length });
        return rows;
    }
    return [];
}

async function recognizePages({ job, file, pages, config }) {
    const maxPages = Math.min(pages.length, config.maxOcrPages);
    const recognizedPages = [];
    const allBlocks = [];
    let needsReview = false;
    for (let index = 0; index < maxPages; index += 1) {
        if (isCancelled(job.id)) throw new Error('任务已取消');
        const page = pages[index];
        const imagePath = resolveStoredDocumentPath(page.image_path);
        if (!imagePath || !fs.existsSync(imagePath)) {
            throw new Error(`第 ${page.page_number} 页预览图不存在，无法进行 OCR。`);
        }
        const result = await recognizePage(imagePath, {
            language: config.language,
            engine: config.engine,
            dpi: config.dpi,
            timeoutMs: config.timeoutMs,
            confidenceThreshold: config.confidenceThreshold
        });
        const pageNeedsReview = Number(result.confidence || 0) < config.confidenceThreshold;
        needsReview = needsReview || pageNeedsReview;
        const updatedPage = updatePageText({
            pageId: page.id,
            text: result.text,
            ocrStatus: pageNeedsReview ? JOB_STATUSES.NEEDS_REVIEW : JOB_STATUSES.SUCCEEDED,
            confidence: result.confidence
        });
        insertOcrBlocks({
            userId: job.user_id,
            fileId: file.id,
            jobId: job.id,
            pageId: page.id,
            pageNumber: page.page_number,
            blocks: result.blocks
        });
        recognizedPages.push(updatedPage);
        allBlocks.push(...result.blocks);
        touchProgress(job.id, 35 + Math.floor(((index + 1) / maxPages) * 50), { processedPages: index + 1 });
    }
    if (pages.length > maxPages) needsReview = true;
    return { pages: recognizedPages, blocks: allBlocks, needsReview, truncated: pages.length > maxPages };
}

async function processTextExtraction({ job, file, filePath, config }) {
    const text = truncateExtractedText(await extractDocumentText(filePath, '', file.original_name, { password: config.password }), getKnowledgeLimits().extractMaxChars);
    const normalizedText = String(text || '').trim();
    if (normalizedText) {
        const page = insertPage({
            userId: job.user_id,
            fileId: file.id,
            jobId: job.id,
            pageNumber: 1,
            text: normalizedText,
            ocrStatus: 'text_extracted',
            confidence: 1
        });
        const outputs = createTextOutputs({ userId: job.user_id, file, job, text: normalizedText, pages: [page], blocks: [] });
        return {
            status: JOB_STATUSES.SUCCEEDED,
            progress: 100,
            result: { textLength: normalizedText.length, outputs, extractedDirectly: true }
        };
    }

    if (isPdfExtension(file.file_ext)) {
        const pages = await preparePagesForJob({ job, file, filePath, config });
        if (job.job_type === JOB_TYPES.OCR) {
            const recognized = await recognizePages({ job, file, pages, config });
            const finalPages = getPages(job.id);
            const blocks = getBlocks(job.id);
            const outputs = createTextOutputs({ userId: job.user_id, file, job, pages: finalPages, blocks });
            return {
                status: recognized.needsReview ? JOB_STATUSES.NEEDS_REVIEW : JOB_STATUSES.SUCCEEDED,
                progress: 100,
                result: { requiresOcr: false, textLength: pagesToText(finalPages).length, outputs, lowConfidence: recognized.needsReview, truncated: recognized.truncated }
            };
        }
        return {
            status: JOB_STATUSES.NEEDS_REVIEW,
            progress: 100,
            result: { requiresOcr: true, renderedPages: pages.length, message: 'PDF 未抽取到文本，已渲染页面，等待 OCR 识别或人工确认。' }
        };
    }

    return {
        status: JOB_STATUSES.NEEDS_REVIEW,
        progress: 100,
        result: { requiresOcr: isImageExtension(file.file_ext), textLength: 0, message: '未抽取到文本，可能需要 OCR 识别。' }
    };
}

async function processImageOcr({ job, file, filePath, config }) {
    const pages = await preparePagesForJob({ job, file, filePath, config });
    const recognized = await recognizePages({ job, file, pages, config });
    const finalPages = getPages(job.id);
    const blocks = getBlocks(job.id);
    const outputs = createTextOutputs({ userId: job.user_id, file, job, pages: finalPages, blocks });
    return {
        status: recognized.needsReview ? JOB_STATUSES.NEEDS_REVIEW : JOB_STATUSES.SUCCEEDED,
        progress: 100,
        result: { textLength: pagesToText(finalPages).length, outputs, lowConfidence: recognized.needsReview, truncated: recognized.truncated }
    };
}

async function processPdfToolJob({ job, file, config }) {
    const sourceIds = (Array.isArray(config.sourceFileIds) && config.sourceFileIds.length ? config.sourceFileIds : [file.id])
        .map(id => Number.parseInt(id, 10))
        .filter(id => Number.isSafeInteger(id) && id > 0)
        .slice(0, 50);
    const files = sourceIds.map(id => getDocumentFileForUser(id, job.user_id)).filter(Boolean);
    if (!files.length) throw new Error('PDF \u5de5\u5177\u4efb\u52a1\u7684\u6e90\u6587\u4ef6\u4e0d\u5b58\u5728\uff0c\u8bf7\u91cd\u65b0\u4e0a\u4f20\u3002');
    const operation = normalizePdfOperation(config.operation);
    if (operation === PDF_TOOL_OPERATIONS.SEARCHABLE_PDF) {
        const targetFile = files.find(item => isPdfExtension(item.file_ext) || isImageExtension(item.file_ext)) || files[0];
        const targetPath = getDocumentFilePath(targetFile);
        if (!targetPath) throw new Error('PDF \u5de5\u5177\u4efb\u52a1\u7684\u6e90\u6587\u4ef6\u4e0d\u5b58\u5728\uff0c\u8bf7\u91cd\u65b0\u4e0a\u4f20\u3002');
        const pageLimit = Math.min(Math.max(Number.parseInt(config.maxToolPages, 10) || 20, 1), 300);
        const searchableConfig = {
            ...config,
            maxRenderPages: Math.min(Math.max(Number.parseInt(config.maxRenderPages, 10) || pageLimit, 1), pageLimit),
            maxOcrPages: Math.min(Math.max(Number.parseInt(config.maxOcrPages, 10) || pageLimit, 1), pageLimit)
        };
        const pages = await preparePagesForJob({ job, file: targetFile, filePath: targetPath, config: searchableConfig });
        const recognized = await recognizePages({ job, file: targetFile, pages, config: searchableConfig });
        const finalPages = getPages(job.id);
        const blocks = getBlocks(job.id);
        const output = await createSearchablePdfOutput({ userId: job.user_id, file: targetFile, job, pages: finalPages, blocks });
        return {
            status: recognized.needsReview ? JOB_STATUSES.NEEDS_REVIEW : JOB_STATUSES.SUCCEEDED,
            progress: 100,
            result: {
                operation,
                outputs: [output],
                processedFiles: 1,
                processedPages: finalPages.length,
                lowConfidence: recognized.needsReview,
                truncated: recognized.truncated
            }
        };
    }
    const result = await processPdfToolOperation({
        job,
        file: files[0],
        files,
        config,
        onProgress: (progress, patch = {}) => touchProgress(job.id, progress, patch)
    });
    return {
        status: JOB_STATUSES.SUCCEEDED,
        progress: 100,
        result: {
            operation: result.operation,
            outputs: result.outputs || [],
            processedFiles: result.processedFiles || files.length,
            processedPages: result.processedPages || 0,
            removedPages: result.removedPages || 0,
            textLength: result.textLength || 0
        }
    };
}

async function processJob(jobId) {
    const job = getJobRow(jobId);
    if (!job || job.status !== JOB_STATUSES.QUEUED) return null;
    const file = getDocumentFileForUser(job.file_id, job.user_id);
    const filePath = getDocumentFilePath(file);
    if (!file || !filePath) {
        return setJobStatus(jobId, JOB_STATUSES.FAILED, { progress: 0, errorMessage: '原始文件不存在，请重新上传。' });
    }
    const config = normalizeConfig(parseJson(job.config_json, {}));
    db.prepare(`
        UPDATE document_jobs
        SET status = ?, progress = ?, attempts = attempts + 1, locked_at = ?, updated_at = ?
        WHERE id = ?
    `).run(JOB_STATUSES.PROCESSING, 5, getBeijingTimestamp(), getBeijingTimestamp(), jobId);

    try {
        if (isCancelled(jobId)) return getJobRow(jobId);
        cleanupJobArtifacts(jobId);
        touchProgress(jobId, 12, { fileType: file.file_type });
        let outcome;
        if (job.job_type === JOB_TYPES.PDF_TOOL) {
            outcome = await processPdfToolJob({ job, file, config });
        } else if (job.job_type === JOB_TYPES.OCR) {
            outcome = await processImageOcr({ job, file, filePath, config });
        } else if (job.job_type === JOB_TYPES.AUTO && isImageExtension(file.file_ext)) {
            const pages = await preparePagesForJob({ job, file, filePath, config });
            outcome = {
                status: JOB_STATUSES.NEEDS_REVIEW,
                progress: 100,
                result: { requiresOcr: true, renderedPages: pages.length, message: '图片文件已登记并生成预览，等待 OCR 识别或人工确认。' }
            };
        } else if (isTextExtractableExtension(file.file_ext)) {
            outcome = await processTextExtraction({ job, file, filePath, config });
        } else {
            outcome = { status: JOB_STATUSES.NEEDS_REVIEW, progress: 100, result: { message: '该文件类型暂不支持自动文本抽取。' } };
        }
        if (isCancelled(jobId)) return getJobRow(jobId);
        return setJobStatus(jobId, outcome.status, { progress: outcome.progress, result: outcome.result, errorMessage: '' });
    } catch (error) {
        if (isCancelled(jobId)) return getJobRow(jobId);
        const message = sanitizeErrorMessage(error);
        return setJobStatus(jobId, JOB_STATUSES.FAILED, { progress: 0, errorMessage: message, result: { failedAt: getBeijingTimestamp() } });
    }
}

function retryJob({ userId, jobId }) {
    const job = getJobRow(jobId, userId);
    if (!job) return null;
    const retryableStatuses = [
        JOB_STATUSES.FAILED,
        JOB_STATUSES.NEEDS_REVIEW,
        JOB_STATUSES.CANCELLED,
        JOB_STATUSES.SUCCEEDED
    ];
    if (!retryableStatuses.includes(job.status)) {
        const error = new Error('只有失败、待复核、已取消或已完成任务可以重试。');
        error.status = 409;
        throw error;
    }
    cleanupJobArtifacts(job.id);
    db.prepare(`
        UPDATE document_jobs
        SET status = ?, progress = 0, error_message = '', result_json = '{}', cancelled_at = NULL, completed_at = NULL, updated_at = ?
        WHERE id = ? AND user_id = ?
    `).run(JOB_STATUSES.QUEUED, getBeijingTimestamp(), job.id, userId);
    enqueueJob(job.id);
    return getJobDetail({ userId, jobId: job.id });
}

function cancelJob({ userId, jobId }) {
    const job = getJobRow(jobId, userId);
    if (!job) return null;
    if ([JOB_STATUSES.SUCCEEDED, JOB_STATUSES.FAILED, JOB_STATUSES.NEEDS_REVIEW, JOB_STATUSES.CANCELLED].includes(job.status)) {
        return getJobDetail({ userId, jobId: job.id });
    }
    const index = queue.indexOf(job.id);
    if (index >= 0) queue.splice(index, 1);
    setJobStatus(job.id, JOB_STATUSES.CANCELLED, { progress: job.progress || 0, result: { message: '用户已取消任务。' } });
    return getJobDetail({ userId, jobId: job.id });
}

function getOutputDownload({ userId, outputId }) {
    const output = getOutputRow(outputId, userId);
    if (!output) return null;
    const filePath = resolveStoredDocumentPath(output.file_path);
    if (!filePath || !fs.existsSync(filePath)) return null;
    return {
        filePath,
        fileName: output.file_name || `document-output-${output.id}`,
        mimeType: output.mime_type || 'application/octet-stream'
    };
}

function getPageImage({ userId, pageId }) {
    const page = db.prepare(`
        SELECT *
        FROM document_pages
        WHERE id = ? AND user_id = ?
    `).get(Number.parseInt(pageId, 10), userId);
    if (!page || !page.image_path) return null;
    const filePath = resolveStoredDocumentPath(page.image_path);
    if (!filePath || !fs.existsSync(filePath)) return null;
    return { filePath, page };
}

function savePageReview({ userId, pageId, revisedText, reviewStatus = 'reviewed', lowConfidenceConfirmed = false }) {
    const page = db.prepare('SELECT * FROM document_pages WHERE id = ? AND user_id = ?').get(Number.parseInt(pageId, 10), userId);
    if (!page) return null;
    const now = getBeijingTimestamp();
    const existing = db.prepare('SELECT * FROM document_reviews WHERE page_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(page.id, userId);
    if (existing) {
        db.prepare(`
            UPDATE document_reviews
            SET review_status = ?, revised_text = ?, low_confidence_confirmed = ?, reviewed_at = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
        `).run(reviewStatus, String(revisedText || '').slice(0, 1000000), lowConfidenceConfirmed ? 1 : 0, now, now, existing.id, userId);
    } else {
        db.prepare(`
            INSERT INTO document_reviews (
                user_id, file_id, job_id, page_id, review_status, original_text, revised_text, low_confidence_confirmed, reviewed_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(userId, page.file_id, page.job_id, page.id, reviewStatus, page.text || '', String(revisedText || '').slice(0, 1000000), lowConfidenceConfirmed ? 1 : 0, now, now, now);
    }
    updatePageText({ pageId: page.id, text: revisedText, ocrStatus: reviewStatus, confidence: lowConfidenceConfirmed ? 1 : page.confidence });
    const job = getJobRow(page.job_id, userId);
    if (job && job.status === JOB_STATUSES.NEEDS_REVIEW) {
        const lowPages = db.prepare(`
            SELECT COUNT(*) AS count
            FROM document_pages
            WHERE job_id = ? AND ocr_status = ?
        `).get(job.id, JOB_STATUSES.NEEDS_REVIEW).count;
        if (Number(lowPages || 0) === 0) {
            setJobStatus(job.id, JOB_STATUSES.SUCCEEDED, { progress: 100, result: { ...parseJson(job.result_json, {}), reviewed: true } });
        }
    }
    return getJobDetail({ userId, jobId: page.job_id });
}


function sanitizeShareFileName(value) {
    const base = path.basename(String(value || 'ocr-result'), path.extname(String(value || ''))).trim() || 'ocr-result';
    return base.replace(/[\\/:*?"<>|\0\r\n\t]/g, ' ').replace(/\s+/g, ' ').slice(0, 80) || 'ocr-result';
}

function buildJobShareText(detail) {
    const pages = Array.isArray(detail?.pages) ? detail.pages : [];
    const chunks = pages.map((page, index) => {
        const text = String(page.text || '').trim();
        if (!text) return '';
        const pageNumber = Number(page.pageNumber || page.page_number || index + 1);
        const confidence = page.confidence === null || page.confidence === undefined
            ? '-'
            : String(Math.round(Number(page.confidence || 0) * 100)) + '%';
        return ['[\u7b2c ' + pageNumber + ' \u9875 | \u7f6e\u4fe1\u5ea6 ' + confidence + ']', text].join('\n');
    }).filter(Boolean);
    return chunks.join('\n\n').trim();
}

function createTempTextUpload({ userId, originalName, text }) {
    const safeName = sanitizeShareFileName(originalName) + '-ocr.txt';
    const diskName = Date.now() + '-' + crypto.randomUUID() + '.txt';
    const targetPath = buildManagedPath(tempRoot, userId, diskName);
    fs.writeFileSync(targetPath, String(text || ''), 'utf8');
    const stat = fs.statSync(targetPath);
    return {
        path: targetPath,
        originalname: safeName,
        mimetype: 'text/plain',
        size: stat.size
    };
}

async function shareJobResult({ user, jobId, target, options = {} }) {
    const userId = user?.id;
    const detail = getJobDetail({ userId, jobId });
    if (!detail) return null;
    const text = buildJobShareText(detail);
    if (!text) {
        const error = new Error('\u6682\u65e0\u53ef\u5206\u53d1\u7684 OCR \u6587\u672c\u3002');
        error.status = 400;
        throw error;
    }
    const normalizedTarget = String(target || '').trim().toLowerCase().replace(/_/g, '-');
    const originalName = detail.file?.originalName || ('ocr-job-' + detail.job.id);
    if (normalizedTarget === 'knowledge' || normalizedTarget === 'knowledge-base' || normalizedTarget === 'rag') {
        const upload = createTempTextUpload({ userId, originalName, text });
        const tags = Array.isArray(options.tags) ? options.tags : String(options.tags || 'ocr').split(/[;,\s]+/);
        const created = createKnowledgeDocumentFromUpload({
            userId,
            file: upload,
            collectionId: options.collectionId,
            tags: tags.filter(Boolean)
        });
        const scheduled = scheduleKnowledgeDocumentIndexing({ docId: created.docId, userId, user });
        return {
            target: 'knowledge',
            documentId: created.docId,
            collectionId: created.collectionId || null,
            scheduled: Boolean(scheduled.started),
            textLength: text.length
        };
    }
    if (normalizedTarget === 'regulations' || normalizedTarget === 'regulation') {
        const upload = createTempTextUpload({ userId, originalName, text });
        const title = String(options.title || sanitizeShareFileName(originalName) + ' OCR').slice(0, 120);
        const created = await createRegulationDocumentFromUpload({
            userId,
            file: upload,
            metadata: {
                title,
                category: options.category || 'OCR',
                jurisdiction: options.jurisdiction || '',
                summary: options.summary || ('\u6765\u81ea\u6587\u5b57\u8bc6\u522b\u4efb\u52a1 ' + detail.job.id)
            },
            preloadedText: text
        });
        return {
            target: 'regulations',
            documentId: created.document?.id || null,
            versionId: created.version?.id || null,
            articleCount: Array.isArray(created.articles) ? created.articles.length : 0,
            textLength: text.length
        };
    }
    return {
        target: normalizedTarget || 'text',
        textLength: text.length
    };
}

async function createJobExport({ userId, jobId, format = OUTPUT_TYPES.TEXT }) {
    const job = getJobRow(jobId, userId);
    if (!job) return null;
    const file = getDocumentFileForUser(job.file_id, userId);
    const pages = getPages(job.id);
    const blocks = getBlocks(job.id);
    const normalizedFormat = Object.values(OUTPUT_TYPES).includes(format) ? format : OUTPUT_TYPES.TEXT;
    if (normalizedFormat === OUTPUT_TYPES.SEARCHABLE_PDF) {
        return createSearchablePdfOutput({ userId, file, job, pages, blocks });
    }
    const outputs = createTextOutputs({ userId, file, job, pages, blocks, formats: [normalizedFormat] });
    return outputs[0] || null;
}

function rowsToCountObject(rows, key = 'status') {
    return rows.reduce((acc, row) => {
        acc[row[key] || 'unknown'] = Number(row.count || 0);
        return acc;
    }, {});
}

function getDocumentProcessingStats() {
    const jobsByStatus = rowsToCountObject(db.prepare('SELECT status, COUNT(*) AS count FROM document_jobs GROUP BY status').all(), 'status');
    const jobsByType = rowsToCountObject(db.prepare('SELECT job_type, COUNT(*) AS count FROM document_jobs GROUP BY job_type').all(), 'job_type');
    const outputs = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(file_size), 0) AS bytes FROM document_outputs').get();
    const durationSql = [
        'SELECT AVG((julianday(completed_at) - julianday(created_at)) * 86400.0) AS seconds',
        'FROM document_jobs',
        "WHERE completed_at IS NOT NULL AND completed_at != ''"
    ].join('\n');
    const duration = db.prepare(durationSql).get();
    const failuresSql = [
        'SELECT j.id, j.job_type, j.status, j.error_message, j.updated_at, f.original_name',
        'FROM document_jobs j',
        'LEFT JOIN document_files f ON f.id = j.file_id',
        'WHERE j.status = ?',
        'ORDER BY j.updated_at DESC, j.id DESC',
        'LIMIT 10'
    ].join('\n');
    const recentFailures = db.prepare(failuresSql).all(JOB_STATUSES.FAILED).map(row => ({
        id: row.id,
        jobType: row.job_type,
        status: row.status,
        errorMessage: row.error_message || '',
        updatedAt: row.updated_at,
        originalName: row.original_name || ''
    }));
    return {
        settings: getDocumentProcessingSettings(),
        queue: getQueueStatus(),
        jobsByStatus,
        jobsByType,
        outputs: {
            count: Number(outputs.count || 0),
            bytes: Number(outputs.bytes || 0)
        },
        averageDurationSeconds: Number(duration.seconds || 0),
        recentFailures
    };
}

function getQueueStatus() {
    return {
        running: runningCount,
        pending: queue.length,
        maxConcurrent: getMaxConcurrentJobs(),
        runningJobIds: Array.from(runningJobs).slice(0, 20)
    };
}

module.exports = {
    cancelJob,
    createJobExport,
    shareJobResult,
    createJobFromUpload,
    createPdfToolJobFromUploads,
    enqueueJob,
    getDocumentProcessingSettings,
    getDocumentProcessingStats,
    getJobDetail,
    getOutputDownload,
    getPageImage,
    getQueueStatus,
    listJobs,
    processJob,
    retryJob,
    updateDocumentProcessingSettings,
    savePageReview,
    serializeJob
};
