const crypto = require('crypto');
const fs = require('fs');
const { query, queryOne, execute } = require('../../db/client');
const { extractDocumentText, truncateExtractedText } = require('../../document-text');
const { logger } = require('../../logger');
const { getBeijingTimestamp } = require('../../time');
const { getKnowledgeLimits } = require('../resource-limits');
const {
    JOB_STATUSES,
    JOB_TYPES,
    isImageExtension,
    isPdfExtension,
    isTextExtractableExtension,
    normalizeJobStatus,
    normalizeJobType
} = require('./constants');
const {
    getDocumentProcessingSettings,
    getMaxConcurrentJobs,
    normalizeConfig,
    safeJson,
    sanitizeErrorMessage,
    serializeBlock,
    serializeJob,
    serializePage,
    updateDocumentProcessingSettings
} = require('./settings');
const {
    getDocumentFileForUser,
    getDocumentFilePathAsync,
    parseJson,
    registerUploadedFile,
    serializeFile,
    updateDocumentFileMetadata
} = require('./files');
const { createTextOutputs, pagesToText, serializeOutput } = require('./exporters');
const { getJobOutputsArchive, getOutputDownload, getPageImage } = require('./downloads');
const { imageFileToPage, renderPdfPagesToFiles } = require('./renderers');
const { recognizePage } = require('./ocr');
const { PDF_TOOL_OPERATIONS, assertPdfInputFiles, createSearchablePdfOutput, getPdfPageMetrics, preflightPdfFile, processPdfToolOperation, requirePdfOperation } = require('./pdf');
const { resolveStoredDocumentPath, safeUnlinkManaged } = require('./paths');
const { getJobPassword, removeJobSecrets, storeJobPassword } = require('./secrets');
const { createDocumentDistributionService } = require('./distribution');
const { createDocumentProcessingMonitoring } = require('./monitoring');
const { createDocumentExportActions } = require('./export-actions');
const queue = [];
const runningJobs = new Set();
let runningCount = 0;
const JOB_LEASE_MS = Math.max(60_000, Number.parseInt(process.env.DOCUMENT_PROCESSING_JOB_LEASE_MS || String(15 * 60 * 1000), 10) || 15 * 60 * 1000);
const JOB_RECOVERY_BATCH = Math.max(1, Math.min(500, Number.parseInt(process.env.DOCUMENT_PROCESSING_RECOVERY_BATCH || '100', 10) || 100));
function jobLeaseCutoff() { return getBeijingTimestamp(new Date(Date.now() - JOB_LEASE_MS)); }
async function getJobRow(jobId, userId = null) {
    const id = Number.parseInt(jobId, 10);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    if (userId) {
        return await queryOne('SELECT * FROM document_jobs WHERE id = ? AND user_id = ?', [id, userId]) || null;
    }
    return await queryOne('SELECT * FROM document_jobs WHERE id = ?', [id]) || null;
}

async function setJobStatus(jobId, status, patch = {}) {
    const now = getBeijingTimestamp();
    const current = await getJobRow(jobId);
    if (!current) return null;
    const result = patch.result === undefined ? parseJson(current.result_json, {}) : patch.result;
    const progress = patch.progress === undefined ? current.progress : Math.max(0, Math.min(Number(patch.progress) || 0, 100));
    const errorMessage = patch.errorMessage === undefined ? current.error_message : String(patch.errorMessage || '').slice(0, 500);
    const completedAt = [JOB_STATUSES.SUCCEEDED, JOB_STATUSES.FAILED, JOB_STATUSES.PARTIAL_SUCCESS, JOB_STATUSES.NEEDS_REVIEW, JOB_STATUSES.CANCELLED].includes(status)
        ? (patch.completedAt || now)
        : current.completed_at;
    const cancelledAt = status === JOB_STATUSES.CANCELLED ? (patch.cancelledAt || now) : current.cancelled_at;
    const terminal = [JOB_STATUSES.SUCCEEDED, JOB_STATUSES.FAILED, JOB_STATUSES.PARTIAL_SUCCESS, JOB_STATUSES.NEEDS_REVIEW, JOB_STATUSES.CANCELLED].includes(status);
    const refreshLease = status === JOB_STATUSES.PROCESSING;
    await execute(`
        UPDATE document_jobs
        SET status = ?, progress = ?, error_message = ?, result_json = ?, updated_at = ?, completed_at = ?, cancelled_at = ?, locked_at = CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE locked_at END
        WHERE id = ? AND (status <> ? OR ? = ?)
    `, [status, progress, errorMessage, safeJson(result), now, completedAt, cancelledAt, refreshLease, now, terminal, jobId, JOB_STATUSES.CANCELLED, status, JOB_STATUSES.CANCELLED]);
    return await getJobRow(jobId);
}

async function isCancelled(jobId) {
    const row = await getJobRow(jobId);
    return !row || row.status === JOB_STATUSES.CANCELLED;
}

async function touchProgress(jobId, progress, resultPatch = null) {
    const row = await getJobRow(jobId);
    if (!row || [JOB_STATUSES.CANCELLED, JOB_STATUSES.SUCCEEDED, JOB_STATUSES.PARTIAL_SUCCESS, JOB_STATUSES.FAILED, JOB_STATUSES.NEEDS_REVIEW].includes(row.status)) return null;
    const result = resultPatch ? { ...parseJson(row.result_json, {}), ...resultPatch } : parseJson(row.result_json, {});
    return await setJobStatus(jobId, JOB_STATUSES.PROCESSING, { progress, result });
}

async function insertPage({ userId, fileId, jobId, pageNumber, width = 0, height = 0, pixelWidth = width, pixelHeight = height, pdfWidth = 0, pdfHeight = 0, rotation = 0, cropBox = {}, imagePath = '', text = '', ocrStatus = 'pending', confidence = null }) {
    const now = getBeijingTimestamp();
    return await queryOne(`
        INSERT INTO document_pages (
            user_id, file_id, job_id, page_number, width, height, pixel_width, pixel_height, pdf_width, pdf_height, rotation, crop_box_json, image_path, text, text_length, ocr_status, confidence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
    `, [userId, fileId, jobId, pageNumber, width, height, pixelWidth, pixelHeight, pdfWidth, pdfHeight, rotation, safeJson(cropBox), imagePath, text, String(text || '').length, ocrStatus, confidence, now, now]);
}

async function updatePageText({ pageId, text, ocrStatus, confidence }) {
    return await queryOne(`
        UPDATE document_pages
        SET text = ?, text_length = ?, ocr_status = ?, confidence = ?, updated_at = ?
        WHERE id = ?
        RETURNING *
    `, [String(text || ''), String(text || '').length, ocrStatus, confidence, getBeijingTimestamp(), pageId]);
}

async function insertOcrBlocks({ userId, fileId, jobId, pageId, pageNumber, blocks = [] }) {
    if (!blocks || !blocks.length) return;
    const now = getBeijingTimestamp();
    // OCR 一页可包含数百文本块；按批写入避免逐条数据库往返和事务放大。
    const batchSize = 500;
    for (let offset = 0; offset < blocks.length; offset += batchSize) {
        const batch = blocks.slice(offset, offset + batchSize);
        await execute(`
            INSERT INTO document_ocr_blocks (
                user_id, file_id, job_id, page_id, page_number, sort_order, block_type, text, bbox_json, confidence, language, engine, created_at, updated_at
            ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
        `, batch.flatMap((block, index) => [
            userId, fileId, jobId, pageId, pageNumber,
            Number(block.sortOrder ?? (offset + index)),
            block.blockType || 'line', String(block.text || '').trim(),
            safeJson(block.bbox || []), Number(block.confidence || 0),
            block.language || '', block.engine || '', now, now
        ]));
    }
}

async function getPages(jobId) {
    return await query('SELECT * FROM document_pages WHERE job_id = ? ORDER BY page_number ASC, id ASC', [jobId]);
}

async function getBlocks(jobId) {
    return await query('SELECT * FROM document_ocr_blocks WHERE job_id = ? ORDER BY page_number ASC, sort_order ASC, id ASC', [jobId]);
}

async function getOutputs(jobId) {
    return await query('SELECT * FROM document_outputs WHERE job_id = ? AND status = ? ORDER BY created_at DESC, id DESC', [jobId, 'ready']);
}

async function getJobItems(jobId) {
    return await query('SELECT * FROM document_job_items WHERE job_id = ? ORDER BY item_order ASC, id ASC', [jobId]);
}

async function resetJobItems(jobId) {
    await execute('DELETE FROM document_job_items WHERE job_id = ?', [jobId]);
}

async function recordJobItem({ job, file, itemOrder, status, progress = 100, errorCode = '', errorMessage = '', result = {} }) {
    await execute(`
        INSERT INTO document_job_items (
            user_id, job_id, file_id, item_order, status, progress, error_code, error_message, result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        job.user_id,
        job.id,
        file.id,
        itemOrder,
        status,
        Math.min(Math.max(Number(progress) || 0, 0), 100),
        String(errorCode || '').slice(0, 80),
        String(errorMessage || '').slice(0, 500),
        safeJson(result),
        getBeijingTimestamp(),
        getBeijingTimestamp()
    ]);
}

async function getReviews(jobId) {
    return await query('SELECT * FROM document_reviews WHERE job_id = ? ORDER BY updated_at DESC, id DESC', [jobId]);
}

async function cleanupJobArtifacts(jobId) {
    const outputs = await query('SELECT file_path FROM document_outputs WHERE job_id = ?', [jobId]);
    const pages = await query('SELECT image_path FROM document_pages WHERE job_id = ?', [jobId]);
    await Promise.all([
        ...outputs.map(row => safeUnlinkManaged(row.file_path)),
        ...pages
            .filter(row => String(row.image_path || '').includes('/pages/'))
            .map(row => safeUnlinkManaged(row.image_path))
    ]);
    await execute('DELETE FROM document_outputs WHERE job_id = ?', [jobId]);
    await execute('DELETE FROM document_ocr_blocks WHERE job_id = ?', [jobId]);
    await execute('DELETE FROM document_reviews WHERE job_id = ?', [jobId]);
    await execute('DELETE FROM document_job_items WHERE job_id = ?', [jobId]);
    await execute('DELETE FROM document_pages WHERE job_id = ?', [jobId]);
}

function removeQueuedJob(jobId) {
    const id = Number.parseInt(jobId, 10);
    let index = queue.indexOf(id);
    while (index >= 0) {
        queue.splice(index, 1);
        index = queue.indexOf(id);
    }
}

function getJobSourceFileIds(job) {
    const ids = new Set();
    const primaryId = Number.parseInt(job?.file_id, 10);
    if (Number.isSafeInteger(primaryId) && primaryId > 0) ids.add(primaryId);
    const config = parseJson(job?.config_json, {});
    const sourceIds = Array.isArray(config.sourceFileIds) ? config.sourceFileIds : [];
    sourceIds.forEach(value => {
        const id = Number.parseInt(value, 10);
        if (Number.isSafeInteger(id) && id > 0) ids.add(id);
    });
    return Array.from(ids);
}

async function cleanupJobSourceFiles(job, userId) {
    const now = getBeijingTimestamp();
    const fileIds = getJobSourceFileIds(job);
    for (const fileId of fileIds) {
        const row = await queryOne('SELECT id, file_path FROM document_files WHERE id = ? AND user_id = ?', [fileId, userId]);
        if (!row) continue;
        await safeUnlinkManaged(row.file_path);
        await execute(`
            UPDATE document_files
            SET deleted_at = COALESCE(deleted_at, ?), updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [now, now, fileId, userId]);
    }
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
        runningCount += 1;
        runningJobs.add(jobId);
        setImmediate(async () => {
            try {
                const row = await getJobRow(jobId);
                if (row && row.status === JOB_STATUSES.QUEUED) {
                    await processJob(jobId);
                }
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

async function recoverDocumentProcessingJobs({ limit = JOB_RECOVERY_BATCH } = {}) {
    const now = getBeijingTimestamp();
    const cutoff = jobLeaseCutoff();
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || JOB_RECOVERY_BATCH, 500));
    const requeued = await execute(`
        UPDATE document_jobs
        SET status = ?, locked_at = NULL, updated_at = ?, error_message = ''
        WHERE status = ? AND locked_at IS NOT NULL AND locked_at < ? AND attempts < max_attempts
    `, [JOB_STATUSES.QUEUED, now, JOB_STATUSES.PROCESSING, cutoff]);
    const failed = await execute(`
        UPDATE document_jobs
        SET status = ?, locked_at = NULL, completed_at = ?, updated_at = ?,
            error_message = CASE WHEN error_message = '' THEN ? ELSE error_message END
        WHERE status = ? AND locked_at IS NOT NULL AND locked_at < ? AND attempts >= max_attempts
    `, [JOB_STATUSES.FAILED, now, now, '任务处理租约已过期且达到最大重试次数。', JOB_STATUSES.PROCESSING, cutoff]);
    const pending = await query(`
        SELECT id
        FROM document_jobs
        WHERE status = ? AND (locked_at IS NULL OR locked_at < ?)
        ORDER BY created_at ASC, id ASC
        LIMIT ?
    `, [JOB_STATUSES.QUEUED, cutoff, safeLimit]);
    pending.forEach(row => enqueueJob(row.id));
    if (requeued || failed || pending.length) {
        logger.info({ requeued, failed, enqueued: pending.length }, '文档处理任务恢复扫描完成');
    }
    return { requeued, failed, enqueued: pending.length };
}

async function createJobRecord({ userId, fileId, jobType, sourceModule, config, parentJobId = null }) {
    const now = getBeijingTimestamp();
    const normalizedConfig = normalizeConfig(config);
    const row = await queryOne(`
        INSERT INTO document_jobs (
            user_id, file_id, job_type, status, progress, config_json, result_json, attempts, max_attempts, source_module, config_version, parent_job_id, attempt_token, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
    `, [userId, fileId, normalizeJobType(jobType), JOB_STATUSES.QUEUED, 0, safeJson(normalizedConfig), '{}', 0, 3, sourceModule, normalizedConfig.configVersion || 2, parentJobId, crypto.randomUUID(), now, now]);
    return row;
}

async function createJobFromUpload({ user, file, jobType = JOB_TYPES.AUTO, sourceModule = 'document_processing', sourceRef = '', config = {} }) {
    const registeredFile = await registerUploadedFile({ user, file, sourceModule, sourceRef, metadata: { createdBy: sourceModule } });
    let job;
    try {
        job = await createJobRecord({ userId: user.id, fileId: registeredFile.id, jobType, sourceModule, config });
        if (String(config.password || '').trim()) await storeJobPassword({ userId: user.id, jobId: job.id, password: config.password });
    } catch (error) {
        await cleanupJobSourceFiles({ file_id: registeredFile.id, config_json: '{}' }, user.id).catch(() => {});
        throw error;
    }
    enqueueJob(job.id);
    return await getJobDetail({ userId: user.id, jobId: job.id });
}

async function createPdfToolJobFromUploads({ user, files = [], operation, sourceRef = '', config = {} }) {
    const uploadFiles = Array.isArray(files) ? files.filter(Boolean) : [files].filter(Boolean);
    if (!uploadFiles.length) {
        const error = new Error('请上传需要处理的 PDF 或图片文件。');
        error.status = 400;
        throw error;
    }
    const registeredFiles = [];
    try {
        for (const file of uploadFiles.slice(0, 20)) {
            registeredFiles.push(await registerUploadedFile({
                user,
                file,
                sourceModule: 'pdf_tools',
                sourceRef,
                metadata: { createdBy: 'pdf_tools' }
            }));
        }
        assertPdfInputFiles({ operation: requirePdfOperation(operation || config.operation), files: registeredFiles, mode: config.mode });
    } catch (error) {
        if (registeredFiles.length) {
            await cleanupJobSourceFiles({
                file_id: registeredFiles[0].id,
                config_json: JSON.stringify({ sourceFileIds: registeredFiles.map(item => item.id) })
            }, user.id).catch(() => {});
        }
        throw error;
    }
    const firstFile = registeredFiles[0];
    let job;
    try {
        job = await createJobRecord({
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
        if (String(config.password || '').trim()) await storeJobPassword({ userId: user.id, jobId: job.id, password: config.password });
    } catch (error) {
        await cleanupJobSourceFiles({
            file_id: firstFile.id,
            config_json: JSON.stringify({ sourceFileIds: registeredFiles.map(item => item.id) })
        }, user.id).catch(() => {});
        throw error;
    }
    enqueueJob(job.id);
    return await getJobDetail({ userId: user.id, jobId: job.id });
}

async function listJobs({ userId, page = 1, limit = 15, status = '', jobType = '', sourceModule = '' }) {
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
    const countRow = await queryOne(`SELECT COUNT(*) AS count FROM document_jobs j WHERE ${whereSql}`, params);
    const total = Number(countRow?.count || 0);
    const rows = await query(`
        SELECT j.*, f.original_name, f.file_type, f.file_ext, f.file_size, f.page_count
        FROM document_jobs j
        JOIN document_files f ON f.id = j.file_id
        WHERE ${whereSql}
        ORDER BY j.created_at DESC, j.id DESC
        LIMIT ? OFFSET ?
    `, [...params, safeLimit, (safePage - 1) * safeLimit]);
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

function allowedActions(job) {
    const status = job?.status || '';
    return {
        view: Boolean(job),
        cancel: [JOB_STATUSES.QUEUED, JOB_STATUSES.PROCESSING].includes(status),
        retry: [JOB_STATUSES.FAILED, JOB_STATUSES.NEEDS_REVIEW, JOB_STATUSES.CANCELLED].includes(status),
        reprocess: [JOB_STATUSES.SUCCEEDED, JOB_STATUSES.PARTIAL_SUCCESS, JOB_STATUSES.FAILED, JOB_STATUSES.NEEDS_REVIEW, JOB_STATUSES.CANCELLED].includes(status),
        download: [JOB_STATUSES.SUCCEEDED, JOB_STATUSES.PARTIAL_SUCCESS, JOB_STATUSES.NEEDS_REVIEW].includes(status),
        delete: ![JOB_STATUSES.QUEUED, JOB_STATUSES.PROCESSING].includes(status)
    };
}

async function getJobPreflight(job, file) {
    const config = parseJson(job?.config_json, {});
    const sourceIds = Array.isArray(config.sourceFileIds) && config.sourceFileIds.length ? config.sourceFileIds : [file?.id];
    const sources = [];
    for (const sourceId of sourceIds.slice(0, 20)) {
        const source = await getDocumentFileForUser(sourceId, job.user_id);
        if (source) sources.push(await preflightPdfFile(source, { maxPages: config.maxToolPages || 300 }));
    }
    return {
        operation: config.operation || '',
        mode: config.mode || 'single',
        files: sources,
        totalPages: sources.reduce((sum, source) => sum + Number(source.pageCount || 0), 0),
        warnings: sources.flatMap(source => source.warnings || [])
    };
}

async function getJobDetail({ userId, jobId, sourceModule = '' }) {
    const job = await getJobRow(jobId, userId);
    if (!job) return null;
    if (sourceModule && job.source_module !== sourceModule) return null;
    const file = await getDocumentFileForUser(job.file_id, userId);
    const pages = await getPages(job.id);
    const blocks = await getBlocks(job.id);
    const outputs = await getOutputs(job.id);
    const reviews = await getReviews(job.id);
    const items = await getJobItems(job.id);
    return {
        job: { ...serializeJob(job), allowedActions: allowedActions(job) },
        file: serializeFile(file),
        pages: pages.map(serializePage),
        blocks: blocks.map(serializeBlock),
        outputs: outputs.map(serializeOutput),
        items: items.map(row => ({
            id: row.id,
            fileId: row.file_id,
            itemOrder: Number(row.item_order || 0),
            status: row.status || '',
            progress: Number(row.progress || 0),
            errorCode: row.error_code || '',
            errorMessage: row.error_message || '',
            result: parseJson(row.result_json, {})
        })),
        reviews: reviews.map(row => ({
            id: row.id,
            pageId: row.page_id,
            reviewStatus: row.review_status,
            revisedText: row.revised_text,
            lowConfidenceConfirmed: Boolean(row.low_confidence_confirmed),
            reviewedAt: row.reviewed_at,
            updatedAt: row.updated_at
        })),
        preflight: job.source_module === 'pdf_tools' ? await getJobPreflight(job, file) : null
    };
}

async function preparePagesForJob({ job, file, filePath, config }) {
    const userId = job.user_id;
    const ext = file.file_ext;
    if (isImageExtension(ext)) {
        const page = await imageFileToPage({ filePath, relativePath: file.file_path, pageNumber: 1 });
        const row = await insertPage({
            userId,
            fileId: file.id,
            jobId: job.id,
            ...page,
            pixelWidth: page.width,
            pixelHeight: page.height,
            pdfWidth: Number(page.width || 0) * 72 / Math.max(Number(config.dpi || 220), 72),
            pdfHeight: Number(page.height || 0) * 72 / Math.max(Number(config.dpi || 220), 72),
            ocrStatus: job.job_type === JOB_TYPES.OCR ? 'processing' : 'pending'
        });
        await updateDocumentFileMetadata({ fileId: file.id, userId, pageCount: 1, metadata: { image: { width: page.width, height: page.height } } });
        return [row];
    }
    if (isPdfExtension(ext)) {
        const metrics = await getPdfPageMetrics(file);
        const rendered = await renderPdfPagesToFiles({
            filePath,
            userId,
            jobId: job.id,
            options: { password: config.password, maxPages: config.maxRenderPages, desiredWidth: Math.round(config.dpi * 6.4) }
        });
        const rows = [];
        for (const page of rendered) {
            const metric = metrics.find(item => item.pageNumber === page.pageNumber) || {};
            rows.push(await insertPage({
                userId,
                fileId: file.id,
                jobId: job.id,
                pageNumber: page.pageNumber,
                width: page.width,
                height: page.height,
                pixelWidth: page.pixelWidth || page.width,
                pixelHeight: page.pixelHeight || page.height,
                pdfWidth: metric.pdfWidth || 0,
                pdfHeight: metric.pdfHeight || 0,
                rotation: metric.rotation || 0,
                cropBox: metric.cropBox || {},
                imagePath: page.imagePath,
                ocrStatus: job.job_type === JOB_TYPES.OCR ? 'processing' : 'pending'
            }));
        }
        const requestedPages = Math.min(metrics.length, config.maxRenderPages);
        if (rows.length !== requestedPages) {
            throw new Error(`PDF 预览仅生成 ${rows.length}/${requestedPages} 页，未发布不完整的识别结果。`);
        }
        await updateDocumentFileMetadata({ fileId: file.id, userId, pageCount: metrics.length, metadata: { pdf: { totalPages: metrics.length, renderedPages: rows.length } } });
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
        if (await isCancelled(job.id)) throw new Error('任务已取消');
        const page = pages[index];
        const imagePath = resolveStoredDocumentPath(page.image_path);
        if (!imagePath || !await fs.promises.access(imagePath, fs.constants.R_OK).then(() => true).catch(() => false)) {
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
        const updatedPage = await updatePageText({
            pageId: page.id,
            text: result.text,
            ocrStatus: pageNeedsReview ? JOB_STATUSES.NEEDS_REVIEW : JOB_STATUSES.SUCCEEDED,
            confidence: result.confidence
        });
        await insertOcrBlocks({
            userId: job.user_id,
            fileId: file.id,
            jobId: job.id,
            pageId: page.id,
            pageNumber: page.page_number,
            blocks: result.blocks
        });
        recognizedPages.push(updatedPage);
        allBlocks.push(...result.blocks);
        await touchProgress(job.id, 35 + Math.floor(((index + 1) / maxPages) * 50), { processedPages: index + 1 });
    }
    if (pages.length > maxPages) needsReview = true;
    return { pages: recognizedPages, blocks: allBlocks, needsReview, truncated: pages.length > maxPages };
}

async function processTextExtraction({ job, file, filePath, config }) {
    const text = truncateExtractedText(await extractDocumentText(filePath, '', file.original_name, { password: config.password, maxChars: getKnowledgeLimits().extractMaxChars }), getKnowledgeLimits().extractMaxChars);
    const normalizedText = String(text || '').trim();
    if (normalizedText) {
        const page = await insertPage({
            userId: job.user_id,
            fileId: file.id,
            jobId: job.id,
            pageNumber: 1,
            text: normalizedText,
            ocrStatus: 'text_extracted',
            confidence: 1
        });
        const outputs = await createTextOutputs({ userId: job.user_id, file, job, text: normalizedText, pages: [page], blocks: [] });
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
            const finalPages = await getPages(job.id);
            const blocks = await getBlocks(job.id);
            const outputs = await createTextOutputs({ userId: job.user_id, file, job, pages: finalPages, blocks });
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
    const finalPages = await getPages(job.id);
    const blocks = await getBlocks(job.id);
    const outputs = await createTextOutputs({ userId: job.user_id, file, job, pages: finalPages, blocks });
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
    const files = [];
    for (const id of sourceIds) {
        const f = await getDocumentFileForUser(id, job.user_id);
        if (f) files.push(f);
    }
    if (!files.length) throw new Error('PDF 工具任务的源文件不存在，请重新上传。');
    const operation = requirePdfOperation(config.operation);
    const input = assertPdfInputFiles({ operation, files, mode: config.mode });
    if (operation === PDF_TOOL_OPERATIONS.SEARCHABLE_PDF) {
        const targetFile = input.files[0];
        const targetPath = await getDocumentFilePathAsync(targetFile);
        if (!targetPath) throw new Error('PDF 工具任务的源文件不存在，请重新上传。');
        const pageLimit = Math.min(Math.max(Number.parseInt(config.maxToolPages, 10) || 20, 1), 300);
        const searchableConfig = {
            ...config,
            maxRenderPages: pageLimit,
            maxOcrPages: pageLimit
        };
        const pages = await preparePagesForJob({ job, file: targetFile, filePath: targetPath, config: searchableConfig });
        const recognized = await recognizePages({ job, file: targetFile, pages, config: searchableConfig });
        const finalPages = await getPages(job.id);
        const blocks = await getBlocks(job.id);
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
    const runOne = async (source, index = 0, total = 1) => await processPdfToolOperation({
        job,
        file: source,
        files: [source],
        config: { ...config, mode: 'single' },
        isCancelled: () => isCancelled(job.id),
        onProgress: async (progress, patch = {}) => {
            const adjusted = total > 1 ? Math.floor((index / total) * 80 + (progress / 100) * (80 / total) + 10) : progress;
            await touchProgress(job.id, adjusted, patch);
        }
    });
    let result;
    if (config.mode === 'batch' && input.meta.inputMode === 'single-or-batch' && input.files.length > 1) {
        const aggregate = { outputs: [], processedFiles: 0, processedPages: 0, requestedPages: 0, items: [], failedFiles: 0 };
        await resetJobItems(job.id);
        for (let index = 0; index < input.files.length; index += 1) {
            const source = input.files[index];
            try {
                const item = await runOne(source, index, input.files.length);
                aggregate.outputs.push(...(item.outputs || []));
                aggregate.processedFiles += 1;
                aggregate.processedPages += Number(item.processedPages || 0);
                aggregate.requestedPages += Number(item.requestedPages || 0);
                aggregate.items.push({ fileId: source.id, originalName: source.original_name, status: 'succeeded', outputs: item.outputs || [] });
                await recordJobItem({
                    job,
                    file: source,
                    itemOrder: index,
                    status: JOB_STATUSES.SUCCEEDED,
                    result: {
                        outputIds: (item.outputs || []).map(output => output.id).filter(Boolean),
                        processedPages: Number(item.processedPages || 0),
                        requestedPages: Number(item.requestedPages || 0)
                    }
                });
            } catch (error) {
                if (await isCancelled(job.id)) throw error;
                aggregate.failedFiles += 1;
                aggregate.items.push({ fileId: source.id, originalName: source.original_name, status: 'failed', errorCode: error.code || 'PROCESSING_FAILED', errorMessage: sanitizeErrorMessage(error) });
                await recordJobItem({
                    job,
                    file: source,
                    itemOrder: index,
                    status: JOB_STATUSES.FAILED,
                    progress: 0,
                    errorCode: error.code || 'PROCESSING_FAILED',
                    errorMessage: sanitizeErrorMessage(error)
                });
            }
        }
        if (!aggregate.processedFiles) {
            const firstFailure = aggregate.items.find(item => item.status === 'failed');
            const error = new Error(firstFailure?.errorMessage || '批量 PDF 处理失败。');
            error.code = firstFailure?.errorCode || 'PROCESSING_FAILED';
            throw error;
        }
        result = aggregate;
    } else if (operation === PDF_TOOL_OPERATIONS.MERGE || operation === PDF_TOOL_OPERATIONS.IMAGES_TO_PDF) {
        result = await processPdfToolOperation({
            job,
            file: input.files[0],
            files: input.files,
            config,
            isCancelled: () => isCancelled(job.id),
            onProgress: (progress, patch = {}) => touchProgress(job.id, progress, patch)
        });
    } else {
        result = await runOne(input.files[0]);
    }
    return {
        status: result.failedFiles ? JOB_STATUSES.PARTIAL_SUCCESS : JOB_STATUSES.SUCCEEDED,
        progress: 100,
        result: {
            operation: result.operation,
            outputs: result.outputs || [],
            processedFiles: result.processedFiles || 0,
            processedPages: result.processedPages || 0,
            requestedPages: result.requestedPages || 0,
            removedPages: result.removedPages || 0,
            textLength: result.textLength || 0,
            failedFiles: result.failedFiles || 0,
            items: result.items || []
        }
    };
}

async function processJob(jobId) {
    const initialJob = await getJobRow(jobId);
    if (!initialJob || initialJob.status !== JOB_STATUSES.QUEUED) return null;
    const file = await getDocumentFileForUser(initialJob.file_id, initialJob.user_id);
    const filePath = await getDocumentFilePathAsync(file);
    if (!file || !filePath) {
        return await setJobStatus(jobId, JOB_STATUSES.FAILED, { progress: 0, errorMessage: '原始文件不存在，请重新上传。' });
    }
    const now = getBeijingTimestamp();
    const claimed = await execute(`
        UPDATE document_jobs
        SET status = ?, progress = ?, attempts = attempts + 1, locked_at = ?, updated_at = ?
        WHERE id = ? AND status = ? AND cancelled_at IS NULL
    `, [JOB_STATUSES.PROCESSING, 5, now, now, jobId, JOB_STATUSES.QUEUED]);
    if (claimed !== 1) return await getJobRow(jobId);
    const job = await getJobRow(jobId);
    const rawConfig = parseJson(job.config_json, {});
    // 兼容旧任务的明文密码：首次实际执行时立即迁移到短期加密密钥表，
    // 然后回写不含密码的公开配置，避免继续经详情接口泄露。
    const legacyPassword = String(rawConfig.password || '');
    if (legacyPassword) {
        await storeJobPassword({ userId: job.user_id, jobId: job.id, password: legacyPassword });
        delete rawConfig.password;
        rawConfig.requiresPassword = true;
        await execute('UPDATE document_jobs SET config_json = ?, config_version = ?, updated_at = ? WHERE id = ?', [safeJson(normalizeConfig(rawConfig)), 2, getBeijingTimestamp(), job.id]);
    }
    const config = { ...normalizeConfig(rawConfig), password: await getJobPassword({ userId: job.user_id, jobId: job.id }) };
    if (config.requiresPassword && !config.password) {
        return await setJobStatus(jobId, JOB_STATUSES.FAILED, { progress: 0, errorMessage: '文件密码已过期或未提供，请在再次处理时重新输入密码。', result: { errorCode: 'PDF_PASSWORD_REQUIRED' } });
    }

    try {
        if (await isCancelled(jobId)) return await getJobRow(jobId);
        await cleanupJobArtifacts(jobId);
        await touchProgress(jobId, 12, { fileType: file.file_type });
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
        if (await isCancelled(jobId)) {
            await cleanupJobArtifacts(jobId);
            return await getJobRow(jobId);
        }
        return await setJobStatus(jobId, outcome.status, { progress: outcome.progress, result: outcome.result, errorMessage: '' });
    } catch (error) {
        if (await isCancelled(jobId)) {
            await cleanupJobArtifacts(jobId);
            return await getJobRow(jobId);
        }
        const message = sanitizeErrorMessage(error);
        return await setJobStatus(jobId, JOB_STATUSES.FAILED, { progress: 0, errorMessage: message, result: { failedAt: getBeijingTimestamp() } });
    } finally {
        await removeJobSecrets({ userId: job.user_id, jobId: job.id }).catch(() => {});
    }
}

async function retryJob({ userId, jobId, sourceModule = '', password = '' }) {
    const job = await getJobRow(jobId, userId);
    if (!job) return null;
    if (sourceModule && job.source_module !== sourceModule) return null;
    const retryableStatuses = [
        JOB_STATUSES.FAILED,
        JOB_STATUSES.NEEDS_REVIEW,
        JOB_STATUSES.CANCELLED
    ];
    if (!retryableStatuses.includes(job.status)) {
        const error = new Error('只有失败、待复核或已取消任务可以重试；已完成任务请使用再次处理，以保留原结果。');
        error.status = 409;
        throw error;
    }
    if (String(password || '').trim()) await storeJobPassword({ userId, jobId: job.id, password });
    await execute(`
        UPDATE document_jobs
        SET status = ?, progress = 0, error_message = '', result_json = '{}', cancelled_at = NULL, completed_at = NULL, attempt_token = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
    `, [JOB_STATUSES.QUEUED, crypto.randomUUID(), getBeijingTimestamp(), job.id, userId]);
    enqueueJob(job.id);
    return await getJobDetail({ userId, jobId: job.id });
}

async function reprocessJob({ userId, jobId, sourceModule = '', password = '' }) {
    const job = await getJobRow(jobId, userId);
    if (!job || (sourceModule && job.source_module !== sourceModule)) return null;
    const config = parseJson(job.config_json, {});
    const successor = await createJobRecord({
        userId,
        fileId: job.file_id,
        jobType: job.job_type,
        sourceModule: job.source_module,
        config,
        parentJobId: job.id
    });
    if (String(password || '').trim()) await storeJobPassword({ userId, jobId: successor.id, password });
    enqueueJob(successor.id);
    return await getJobDetail({ userId, jobId: successor.id });
}

async function cancelJob({ userId, jobId, sourceModule = '' }) {
    const job = await getJobRow(jobId, userId);
    if (!job) return null;
    if (sourceModule && job.source_module !== sourceModule) return null;
    if ([JOB_STATUSES.SUCCEEDED, JOB_STATUSES.PARTIAL_SUCCESS, JOB_STATUSES.FAILED, JOB_STATUSES.NEEDS_REVIEW, JOB_STATUSES.CANCELLED].includes(job.status)) {
        return await getJobDetail({ userId, jobId: job.id });
    }
    removeQueuedJob(job.id);
    await setJobStatus(job.id, JOB_STATUSES.CANCELLED, { progress: job.progress || 0, result: { message: '用户已取消任务。' } });
    return await getJobDetail({ userId, jobId: job.id });
}

async function deleteJob({ userId, jobId, sourceModule = '' }) {
    const job = await getJobRow(jobId, userId);
    if (!job) return null;
    if (sourceModule && job.source_module !== sourceModule) return null;
    const reference = await queryOne(`
        SELECT COUNT(*) AS count
        FROM document_artifact_refs r
        JOIN document_outputs o ON o.id = r.output_id
        WHERE o.job_id = ? AND r.user_id = ?
    `, [job.id, userId]);
    if (Number(reference?.count || 0) > 0) {
        const error = new Error('该任务的输出已被业务模块引用，不能直接删除。请先在目标模块解除引用。');
        error.status = 409;
        error.code = 'ARTIFACT_REFERENCED';
        throw error;
    }
    const deleted = serializeJob(job);
    removeQueuedJob(job.id);
    if (![JOB_STATUSES.SUCCEEDED, JOB_STATUSES.PARTIAL_SUCCESS, JOB_STATUSES.FAILED, JOB_STATUSES.NEEDS_REVIEW, JOB_STATUSES.CANCELLED].includes(job.status)) {
        await setJobStatus(job.id, JOB_STATUSES.CANCELLED, { progress: job.progress || 0, result: { message: '任务已删除。' } });
    }
    await cleanupJobArtifacts(job.id);
    await removeJobSecrets({ userId, jobId: job.id }).catch(() => {});
    await execute('DELETE FROM document_artifact_refs WHERE output_id IN (SELECT id FROM document_outputs WHERE job_id = ?)', [job.id]);
    await cleanupJobSourceFiles(job, userId);
    await execute('DELETE FROM document_jobs WHERE id = ? AND user_id = ?', [job.id, userId]);
    return deleted;
}

async function savePageReview({ userId, pageId, revisedText, reviewStatus = 'reviewed', lowConfidenceConfirmed = false }) {
    const page = await queryOne('SELECT * FROM document_pages WHERE id = ? AND user_id = ?', [Number.parseInt(pageId, 10), userId]);
    if (!page) return null;
    const now = getBeijingTimestamp();
    const existing = await queryOne('SELECT * FROM document_reviews WHERE page_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1', [page.id, userId]);
    if (existing) {
        await execute(`
            UPDATE document_reviews
            SET review_status = ?, revised_text = ?, low_confidence_confirmed = ?, reviewed_at = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [reviewStatus, String(revisedText || '').slice(0, 1000000), lowConfidenceConfirmed ? 1 : 0, now, now, existing.id, userId]);
    } else {
        await execute(`
            INSERT INTO document_reviews (
                user_id, file_id, job_id, page_id, review_status, original_text, revised_text, low_confidence_confirmed, reviewed_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [userId, page.file_id, page.job_id, page.id, reviewStatus, page.text || '', String(revisedText || '').slice(0, 1000000), lowConfidenceConfirmed ? 1 : 0, now, now, now]);
    }
    await updatePageText({ pageId: page.id, text: revisedText, ocrStatus: reviewStatus, confidence: lowConfidenceConfirmed ? 1 : page.confidence });
    const job = await getJobRow(page.job_id, userId);
    if (job && job.status === JOB_STATUSES.NEEDS_REVIEW) {
        const lowPagesRow = await queryOne(`
            SELECT COUNT(*) AS count
            FROM document_pages
            WHERE job_id = ? AND ocr_status = ?
        `, [job.id, JOB_STATUSES.NEEDS_REVIEW]);
        if (Number(lowPagesRow?.count || 0) === 0) {
            await setJobStatus(job.id, JOB_STATUSES.SUCCEEDED, { progress: 100, result: { ...parseJson(job.result_json, {}), reviewed: true } });
        }
    }
    return await getJobDetail({ userId, jobId: page.job_id });
}

function getQueueStatus() {
    return {
        running: runningCount,
        pending: queue.length,
        maxConcurrent: getMaxConcurrentJobs(),
        runningJobIds: Array.from(runningJobs).slice(0, 20)
    };
}

const distribution = createDocumentDistributionService({ getJobDetail });
const monitoring = createDocumentProcessingMonitoring({ getQueueStatus });
const exportActions = createDocumentExportActions({ getJobRow, getPages, getBlocks });

module.exports = {
    cancelJob,
    createJobExport: exportActions.createJobExport,
    dispatchPdfJobResult: distribution.dispatchPdfJobResult,
    shareJobResult: distribution.shareJobResult,
    createJobFromUpload,
    createPdfToolJobFromUploads,
    deleteJob,
    enqueueJob,
    getDocumentProcessingSettings,
    getDocumentProcessingStats: monitoring.getDocumentProcessingStats,
    getJobDetail,
    getJobOutputsArchive,
    getOutputDownload,
    getPageImage,
    getQueueStatus,
    listJobs,
    processJob,
    recoverDocumentProcessingJobs,
    retryJob,
    reprocessJob,
    updateDocumentProcessingSettings,
    savePageReview,
    serializeJob
};
