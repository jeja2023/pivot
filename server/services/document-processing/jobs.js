const crypto = require('crypto');
const { query, queryOne, execute } = require('../../db/client');
const { withDocumentJobLock } = require('../../repositories/document-job-lock');
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
    serializeJob,
    updateDocumentProcessingSettings
} = require('./settings');
const {
    getDocumentFileForUser,
    getDocumentFilePathAsync,
    parseJson,
    registerUploadedFile,
    updateDocumentFileMetadata
} = require('./files');
const { createTextOutputs, pagesToText } = require('./exporters');
const { getJobOutputsArchive, getJobOutputsArchiveStream, getOutputDownload, getPageImage } = require('./downloads');
const { imageFileToPage, renderPdfPagesToFiles } = require('./renderers');
const { recognizePage } = require('./ocr');
const { PDF_TOOL_OPERATIONS, assertPdfInputFiles, createSearchablePdfOutput, getPdfPageMetrics, parsePageSelection, processPdfToolOperation, requirePdfOperation } = require('./pdf');
const { resolveStoredDocumentPath, safeUnlinkManaged } = require('./paths');
const { getJobPassword, getJobSecret, removeJobSecrets, storeJobPassword, storeJobSecret } = require('./secrets');
const { createDocumentDistributionService } = require('./distribution');
const { createDocumentProcessingMonitoring } = require('./monitoring');
const { createDocumentExportActions } = require('./export-actions');
const { createPdfJobProcessor } = require('./job-pdf');
const { createOcrOperations } = require('./ocr-operations');
const { createOcrJobProcessor } = require('./ocr-job-processor');
const { createDocumentJobDetails } = require('./job-details');
const { buildOcrChatContext } = require('./chat-context');
const { canAccessDocumentJob, markReviewInProgress } = require('./review-assignments');
const { createOcrRegionService } = require('./regions');
const { createOcrFeedbackService } = require('./feedback');
const queue = [];
const runningJobs = new Set();
let runningCount = 0;
const JOB_LEASE_MS = Math.max(60_000, Number.parseInt(process.env.DOCUMENT_PROCESSING_JOB_LEASE_MS || String(15 * 60 * 1000), 10) || 15 * 60 * 1000);
const JOB_RECOVERY_BATCH = Math.max(1, Math.min(500, Number.parseInt(process.env.DOCUMENT_PROCESSING_RECOVERY_BATCH || '100', 10) || 100));
const WORKER_ID = `scoped-v1:${String(process.env.DOCUMENT_PROCESSING_WORKER_ID || `${process.pid}-${crypto.randomUUID()}`).slice(0, 110)}`;
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
    const leaseUntil = getBeijingTimestamp(new Date(Date.now() + JOB_LEASE_MS));
    const expectedEpoch = patch.executionEpoch !== null && patch.executionEpoch !== undefined && Number.isSafeInteger(Number(patch.executionEpoch))
        ? Number(patch.executionEpoch) : null;
    await execute(`
        UPDATE document_jobs
        SET status = ?, progress = ?, error_message = ?, result_json = ?, updated_at = ?, completed_at = ?, cancelled_at = ?,
            locked_at = CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE locked_at END,
            lease_until = CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE lease_until END,
            lease_owner = CASE WHEN ? THEN ? WHEN ? THEN '' ELSE lease_owner END,
            review_state = CASE WHEN ? THEN 'pending' ELSE review_state END
        WHERE id = ? AND (status <> ? OR ? = ?) AND execution_epoch = COALESCE(?, execution_epoch)
            AND (?::bigint IS NULL OR status = ?)
    `, [
        status, progress, errorMessage, safeJson(result), now, completedAt, cancelledAt,
        refreshLease, now, terminal,
        refreshLease, leaseUntil, terminal,
        refreshLease, WORKER_ID, terminal,
        status === JOB_STATUSES.NEEDS_REVIEW,
        jobId, JOB_STATUSES.CANCELLED, status, JOB_STATUSES.CANCELLED, expectedEpoch, expectedEpoch, JOB_STATUSES.PROCESSING
    ]);
    await updateOcrBatchForJob(jobId).catch(() => {});
    return await getJobRow(jobId);
}

async function updateOcrBatchForJob(jobId) {
    const row = await queryOne(`
        SELECT j.id, j.user_id, j.status, f.source_ref
        FROM document_jobs j
        JOIN document_files f ON f.id = j.file_id AND f.user_id = j.user_id
        WHERE j.id = ? AND j.source_module = 'ocr_app'
    `, [jobId]);
    const batchId = String(row?.source_ref || '').trim();
    if (!row || !/^[0-9a-f-]{36}$/i.test(batchId)) return;
    await execute(`
        UPDATE document_batch_items SET status = ?, updated_at = ?
        WHERE batch_id = ? AND user_id = ? AND job_id = ?
    `, [row.status, getBeijingTimestamp(), batchId, row.user_id, row.id]);
    await ocrOperations.refreshOcrBatch(batchId, row.user_id);
}

async function isCancelled(jobId) {
    const row = await getJobRow(jobId);
    return !row || row.status === JOB_STATUSES.CANCELLED;
}

async function touchProgress(jobId, progress, resultPatch = null, executionEpoch = null) {
    const row = await getJobRow(jobId);
    if (!row || [JOB_STATUSES.CANCELLED, JOB_STATUSES.SUCCEEDED, JOB_STATUSES.PARTIAL_SUCCESS, JOB_STATUSES.FAILED, JOB_STATUSES.NEEDS_REVIEW].includes(row.status)) return null;
    const result = resultPatch ? { ...parseJson(row.result_json, {}), ...resultPatch } : parseJson(row.result_json, {});
    return await setJobStatus(jobId, JOB_STATUSES.PROCESSING, { progress, result, executionEpoch });
}

async function insertPage({ userId, fileId, jobId, pageNumber, width = 0, height = 0, pixelWidth = width, pixelHeight = height, pdfWidth = 0, pdfHeight = 0, rotation = 0, cropBox = {}, imagePath = '', text = '', rawText = text, ocrStatus = 'pending', processingState = ocrStatus, confidence = null, result = {}, contentRevision = 1, alignmentStatus = 'aligned' }) {
    const now = getBeijingTimestamp();
    return await queryOne(`
        INSERT INTO document_pages (
            user_id, file_id, job_id, page_number, width, height, pixel_width, pixel_height, pdf_width, pdf_height, rotation, crop_box_json, image_path, text, raw_text, text_length, ocr_status, processing_state, confidence, result_json, content_revision, alignment_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
    `, [userId, fileId, jobId, pageNumber, width, height, pixelWidth, pixelHeight, pdfWidth, pdfHeight, rotation, safeJson(cropBox), imagePath, text, rawText, String(text || '').length, ocrStatus, processingState, confidence, safeJson(result), contentRevision, alignmentStatus, now, now]);
}

async function updatePageText({ pageId, text, rawText = null, ocrStatus, processingState = ocrStatus, confidence, result = null, contentRevision = null, alignmentStatus = null }) {
    const current = await queryOne('SELECT * FROM document_pages WHERE id = ?', [pageId]);
    if (!current) return null;
    return await queryOne(`
        UPDATE document_pages
        SET text = ?, raw_text = ?, text_length = ?, ocr_status = ?, processing_state = ?, confidence = ?, result_json = ?, content_revision = ?, alignment_status = ?, updated_at = ?
        WHERE id = ?
        RETURNING *
    `, [
        String(text || ''),
        rawText === null ? current.raw_text : String(rawText || ''),
        String(text || '').length,
        ocrStatus,
        processingState || current.processing_state || ocrStatus,
        confidence === undefined ? current.confidence : confidence,
        result === null ? current.result_json : safeJson(result),
        contentRevision === null ? current.content_revision : contentRevision,
        alignmentStatus || current.alignment_status || 'aligned',
        getBeijingTimestamp(),
        pageId
    ]);
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
                user_id, file_id, job_id, page_id, page_number, sort_order, block_type, text, raw_text, effective_text, stable_key, bbox_json, confidence, confidence_source, alignment_status, result_revision, language, engine, created_at, updated_at
            ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
        `, batch.flatMap((block, index) => [
            userId, fileId, jobId, pageId, pageNumber,
            Number(block.sortOrder ?? (offset + index)),
            block.blockType || 'line', String(block.text || '').trim(), String(block.text || '').trim(), String(block.text || '').trim(),
            `${pageId}:${Number(block.sortOrder ?? (offset + index))}:${crypto.createHash('sha256').update(String(block.text || '')).digest('hex').slice(0, 16)}`,
            safeJson(block.bbox || []), block.confidence === null || block.confidence === undefined ? null : Number(block.confidence),
            block.confidence === null || block.confidence === undefined ? 'unknown' : 'engine', 'aligned', 1,
            block.language || '', block.engine || '', now, now
        ]));
    }
}

function createCoverage({ sourcePageCount = 0, plannedPages = [], processedPages = [], failedPages = [] } = {}) {
    const sourceCount = Math.max(Number(sourcePageCount) || 0, 0);
    const planned = Array.from(new Set(plannedPages.map(page => Number(page)).filter(page => Number.isSafeInteger(page) && page > 0))).sort((a, b) => a - b);
    const processed = Array.from(new Set(processedPages.map(page => Number(page)).filter(page => planned.includes(page)))).sort((a, b) => a - b);
    const failed = Array.from(new Set(failedPages.map(page => Number(page)).filter(page => planned.includes(page)))).sort((a, b) => a - b);
    const omitted = Array.from({ length: sourceCount }, (_item, index) => index + 1).filter(page => !planned.includes(page));
    return {
        sourcePageCount: sourceCount,
        plannedPages: planned,
        plannedPageCount: planned.length,
        processedPages: processed,
        processedPageCount: processed.length,
        failedPages: failed,
        failedPageCount: failed.length,
        omittedPages: omitted,
        coverageComplete: planned.length > 0 && processed.length + failed.length === planned.length && failed.length === 0
    };
}

async function updateJobCoverage(jobId, coverage) {
    const normalized = createCoverage(coverage);
    const current = await getJobRow(jobId);
    if (!current) return normalized;
    const result = { ...parseJson(current.result_json, {}), coverage: normalized };
    await execute(`
        UPDATE document_jobs
        SET source_page_count = ?, planned_page_count = ?, processed_page_count = ?, failed_page_count = ?,
            omitted_pages_json = ?, coverage_complete = ?, result_json = ?, updated_at = ?
        WHERE id = ?
    `, [
        normalized.sourcePageCount,
        normalized.plannedPageCount,
        normalized.processedPageCount,
        normalized.failedPageCount,
        safeJson(normalized.omittedPages),
        normalized.coverageComplete ? 1 : 0,
        safeJson(result),
        getBeijingTimestamp(),
        jobId
    ]);
    return normalized;
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
    await execute('DELETE FROM document_page_revisions WHERE job_id = ?', [jobId]);
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
        WHERE status = ? AND ((lease_owner LIKE 'scoped-v1:%' AND lease_until < ?) OR ((lease_until IS NULL OR COALESCE(lease_owner, '') NOT LIKE 'scoped-v1:%') AND COALESCE(lease_until, locked_at) < ?)) AND attempts < max_attempts
            AND pg_try_advisory_xact_lock(hashtext('pivot_document_job'), hashtext(id::text))
    `, [JOB_STATUSES.QUEUED, now, JOB_STATUSES.PROCESSING, now, cutoff]);
    const failed = await execute(`
        UPDATE document_jobs
        SET status = ?, locked_at = NULL, completed_at = ?, updated_at = ?,
            error_message = CASE WHEN error_message = '' THEN ? ELSE error_message END
        WHERE status = ? AND ((lease_owner LIKE 'scoped-v1:%' AND lease_until < ?) OR ((lease_until IS NULL OR COALESCE(lease_owner, '') NOT LIKE 'scoped-v1:%') AND COALESCE(lease_until, locked_at) < ?)) AND attempts >= max_attempts
            AND pg_try_advisory_xact_lock(hashtext('pivot_document_job'), hashtext(id::text))
    `, [JOB_STATUSES.FAILED, now, now, '任务处理租约已过期且达到最大重试次数。', JOB_STATUSES.PROCESSING, now, cutoff]);
    const pending = await query(`
        SELECT id
        FROM document_jobs
        WHERE status = ? AND (locked_at IS NULL OR COALESCE(lease_until, locked_at) < ?)
        ORDER BY created_at ASC, id ASC
        LIMIT ?
    `, [JOB_STATUSES.QUEUED, cutoff, safeLimit]);
    pending.forEach(row => enqueueJob(row.id));
    if (requeued || failed || pending.length) {
        logger.info({ requeued, failed, enqueued: pending.length }, '文档处理任务恢复扫描完成');
    }
    const exports = await exportActions.recoverPendingExports({ limit: safeLimit }).catch(error => {
        logger.warn({ err: sanitizeErrorMessage(error) }, '文档异步导出恢复失败');
        return { recovered: 0 };
    });
    return { requeued, failed, enqueued: pending.length, exportsRecovered: exports.recovered };
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

const ocrOperations = createOcrOperations({
    createJobFromUpload,
    execute,
    queryOne,
    getBeijingTimestamp,
    isImageExtension,
    isPdfExtension,
    JOB_STATUSES,
    normalizeConfig,
    parsePageSelection,
    sanitizeErrorMessage
});

const { getJobDetail, extractOcrFields, getJobPageSlice, getPageRevisions } = createDocumentJobDetails({
    canAccessDocumentJob,
    extractOcrFieldsFromDetail: require('./field-extraction').extractOcrFieldsFromDetail,
    getBlocks,
    getDocumentFileForUser,
    getJobItems,
    getJobPassword,
    getJobRow,
    getOutputs,
    getPages,
    getReviews,
    JOB_STATUSES,
    parseJson,
    preflightPdfFile: require('./pdf').preflightPdfFile,
    serializeBlock: require('./settings').serializeBlock,
    serializeFile: require('./files').serializeFile,
    serializeJob,
    serializeOutput: require('./exporters').serializeOutput,
    serializePage: require('./settings').serializePage
});

async function getOcrChatContext({ userId, jobId }) {
    const detail = await getJobDetail({ userId, jobId, sourceModule: 'ocr_app' });
    return detail ? buildOcrChatContext(detail) : null;
}

const ocrRegions = createOcrRegionService({ canAccessDocumentJob, recognizePage });
const ocrFeedback = createOcrFeedbackService({ canAccessDocumentJob });

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
        if (String(config.outputPassword || '').trim()) await storeJobSecret({ userId: user.id, jobId: job.id, purpose: 'output_password', value: config.outputPassword });
        if (String(config.ownerPassword || '').trim()) await storeJobSecret({ userId: user.id, jobId: job.id, purpose: 'owner_password', value: config.ownerPassword });
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
        const pages = await ocrProcessor.preparePagesForJob({ job, file, filePath, config });
        if (job.job_type === JOB_TYPES.OCR) {
            const recognized = await ocrProcessor.recognizePages({ job, file, pages, config });
            const finalPages = await getPages(job.id);
            const blocks = await getBlocks(job.id);
            const outputs = await createTextOutputs({ userId: job.user_id, file, job, pages: finalPages, blocks });
            return {
                status: recognized.failedPages.length ? JOB_STATUSES.PARTIAL_SUCCESS : (recognized.needsReview ? JOB_STATUSES.NEEDS_REVIEW : JOB_STATUSES.SUCCEEDED),
                progress: 100,
                result: { requiresOcr: false, textLength: pagesToText(finalPages).length, outputs, lowConfidence: recognized.needsReview, failedPages: recognized.failedPages, coverage: recognized.coverage, truncated: false }
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

const ocrProcessor = createOcrJobProcessor({
    createTextOutputs,
    getBlocks,
    getJobRow,
    getPages,
    getPdfPageMetrics,
    imageFileToPage,
    insertOcrBlocks,
    insertPage,
    isCancelled,
    isImageExtension,
    isPdfExtension,
    JOB_STATUSES,
    JOB_TYPES,
    parsePageSelection,
    pagesToText,
    recognizePage,
    renderPdfPagesToFiles,
    resolveStoredDocumentPath,
    sanitizeErrorMessage,
    touchProgress,
    updateDocumentFileMetadata,
    updateJobCoverage,
    updatePageText
});

const processPdfToolJob = createPdfJobProcessor({
    assertPdfInputFiles,
    createSearchablePdfOutput,
    getBlocks,
    getDocumentFileForUser,
    getDocumentFilePathAsync,
    getPages,
    isCancelled,
    JOB_STATUSES,
    PDF_TOOL_OPERATIONS,
    preparePagesForJob: (...args) => ocrProcessor.preparePagesForJob(...args),
    processPdfToolOperation,
    recognizePages: (...args) => ocrProcessor.recognizePages(...args),
    recordJobItem,
    requirePdfOperation,
    resetJobItems,
    sanitizeErrorMessage,
    touchProgress
});
async function processJob(jobId) {
    return await withDocumentJobLock(jobId, async () => {
        const initialJob = await getJobRow(jobId);
        if (!initialJob || initialJob.status !== JOB_STATUSES.QUEUED) return null;
        const file = await getDocumentFileForUser(initialJob.file_id, initialJob.user_id);
        const filePath = await getDocumentFilePathAsync(file);
        if (!file || !filePath) {
            return await setJobStatus(jobId, JOB_STATUSES.FAILED, { progress: 0, errorMessage: '原始文件不存在，请重新上传。' });
        }
        const now = getBeijingTimestamp();
        const leaseUntil = getBeijingTimestamp(new Date(Date.now() + JOB_LEASE_MS));
        const claimed = await execute(`
            UPDATE document_jobs
            SET status = ?, progress = ?, attempts = attempts + 1, locked_at = ?, lease_until = ?, lease_owner = ?, execution_epoch = execution_epoch + 1, updated_at = ?
            WHERE id = ? AND status = ? AND cancelled_at IS NULL
        `, [JOB_STATUSES.PROCESSING, 5, now, leaseUntil, WORKER_ID, now, jobId, JOB_STATUSES.QUEUED]);
        if (claimed !== 1) return await getJobRow(jobId);
        const job = await getJobRow(jobId);
        if (!job) return null;
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
        const config = {
            ...normalizeConfig(rawConfig),
            password: await getJobPassword({ userId: job.user_id, jobId: job.id }),
            outputPassword: await getJobSecret({ userId: job.user_id, jobId: job.id, purpose: 'output_password' }),
            ownerPassword: await getJobSecret({ userId: job.user_id, jobId: job.id, purpose: 'owner_password' })
        };
        if (config.requiresPassword && !config.password) {
            return await setJobStatus(jobId, JOB_STATUSES.FAILED, { progress: 0, errorMessage: '文件密码已过期或未提供，请在再次处理时重新输入密码。', result: { errorCode: 'PDF_PASSWORD_REQUIRED' } });
        }

        try {
            if (await isCancelled(jobId)) return await getJobRow(jobId);
            const retryingFailedPages = parseJson(job.result_json, {}).retryFailedPages === true;
            if (!retryingFailedPages) await cleanupJobArtifacts(jobId);
            await touchProgress(jobId, 12, { fileType: file.file_type }, Number(job.execution_epoch));
            let outcome;
            if (job.job_type === JOB_TYPES.PDF_TOOL) {
                outcome = await processPdfToolJob({ job, file, config });
            } else if (job.job_type === JOB_TYPES.OCR && (isImageExtension(file.file_ext) || isPdfExtension(file.file_ext))) {
                outcome = await ocrProcessor.processImageOcr({ job, file, filePath, config });
            } else if (job.job_type === JOB_TYPES.OCR && isTextExtractableExtension(file.file_ext)) {
                outcome = await processTextExtraction({ job, file, filePath, config });
            } else if (job.job_type === JOB_TYPES.AUTO && isImageExtension(file.file_ext)) {
                const pages = await ocrProcessor.preparePagesForJob({ job, file, filePath, config });
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
            return await setJobStatus(jobId, outcome.status, { progress: outcome.progress, result: outcome.result, errorMessage: '', executionEpoch: Number(job.execution_epoch) });
        } catch (error) {
            if (await isCancelled(jobId)) {
                await cleanupJobArtifacts(jobId);
                return await getJobRow(jobId);
            }
            const message = sanitizeErrorMessage(error);
            return await setJobStatus(jobId, JOB_STATUSES.FAILED, { progress: 0, errorMessage: message, result: { failedAt: getBeijingTimestamp() }, executionEpoch: Number(job.execution_epoch) });
        } finally {
            await removeJobSecrets({ userId: job.user_id, jobId: job.id }).catch(() => {});
        }
    });
}

async function retryJob({ userId, jobId, sourceModule = '', password = '', outputPassword = '', ownerPassword = '', retryFailedPages = false }) {
    const job = await getJobRow(jobId, userId);
    if (!job) return null;
    if (sourceModule && job.source_module !== sourceModule) return null;
    const retryableStatuses = [
        JOB_STATUSES.FAILED,
        JOB_STATUSES.PARTIAL_SUCCESS,
        JOB_STATUSES.NEEDS_REVIEW,
        JOB_STATUSES.CANCELLED
    ];
    if (!retryableStatuses.includes(job.status)) {
        const error = new Error('只有失败、待复核或已取消任务可以重试；已完成任务请使用再次处理，以保留原结果。');
        error.status = 409;
        throw error;
    }
    if (String(password || '').trim()) await storeJobPassword({ userId, jobId: job.id, password });
    if (String(outputPassword || '').trim()) await storeJobSecret({ userId, jobId: job.id, purpose: 'output_password', value: outputPassword });
    if (String(ownerPassword || '').trim()) await storeJobSecret({ userId, jobId: job.id, purpose: 'owner_password', value: ownerPassword });
    if (retryFailedPages && sourceModule === 'ocr_app') {
        const failedRows = await query(`
            SELECT * FROM document_pages WHERE job_id = ? AND user_id = ? AND processing_state = ? ORDER BY page_number ASC
        `, [job.id, userId, JOB_STATUSES.FAILED]);
        if (!failedRows.length) {
            const error = new Error('当前任务没有可重试的失败页面。');
            error.status = 409;
            throw error;
        }
        await execute(`
            UPDATE document_pages SET ocr_status = ?, processing_state = ?, updated_at = ?
            WHERE job_id = ? AND user_id = ? AND processing_state = ?
        `, ['pending', 'pending', getBeijingTimestamp(), job.id, userId, JOB_STATUSES.FAILED]);
        const config = parseJson(job.config_json, {});
        const retryPages = failedRows.map(row => Number(row.page_number)).join(',');
        config.pages = retryPages;
        config.pageRanges = retryPages;
        await execute(`
            UPDATE document_jobs
            SET status = ?, progress = 0, error_message = '', cancelled_at = NULL, completed_at = NULL,
                attempt_token = ?, config_json = ?, result_json = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [JOB_STATUSES.QUEUED, crypto.randomUUID(), safeJson(normalizeConfig(config)), safeJson({ ...parseJson(job.result_json, {}), retryFailedPages: true, retriedPages: failedRows.map(row => Number(row.page_number)) }), getBeijingTimestamp(), job.id, userId]);
        enqueueJob(job.id);
        return await getJobDetail({ userId, jobId: job.id });
    }
    await execute(`
        UPDATE document_jobs
        SET status = ?, progress = 0, error_message = '', result_json = '{}', cancelled_at = NULL, completed_at = NULL, attempt_token = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
    `, [JOB_STATUSES.QUEUED, crypto.randomUUID(), getBeijingTimestamp(), job.id, userId]);
    enqueueJob(job.id);
    return await getJobDetail({ userId, jobId: job.id });
}

async function reprocessJob({ userId, jobId, sourceModule = '', password = '', outputPassword = '', ownerPassword = '', configPatch = {} }) {
    const job = await getJobRow(jobId, userId);
    if (!job || (sourceModule && job.source_module !== sourceModule)) return null;
    const previousConfig = parseJson(job.config_json, {});
    const patch = configPatch && typeof configPatch === 'object' && !Array.isArray(configPatch) ? configPatch : {};
    const config = { ...previousConfig, ...patch, sourceFileIds: previousConfig.sourceFileIds || [] };
    const successor = await createJobRecord({
        userId,
        fileId: job.file_id,
        jobType: job.job_type,
        sourceModule: job.source_module,
        config,
        parentJobId: job.id
    });
    if (String(password || '').trim()) await storeJobPassword({ userId, jobId: successor.id, password });
    if (String(outputPassword || '').trim()) await storeJobSecret({ userId, jobId: successor.id, purpose: 'output_password', value: outputPassword });
    if (String(ownerPassword || '').trim()) await storeJobSecret({ userId, jobId: successor.id, purpose: 'owner_password', value: ownerPassword });
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

async function savePageReview({ userId, pageId, revisedText, reviewStatus = 'reviewed', lowConfidenceConfirmed = false, expectedRevision = null, sourceModule = '' }) {
    const page = await queryOne(`
        SELECT p.*, j.status AS job_status, j.source_module, j.content_revision AS job_content_revision,
            j.coverage_complete, j.result_json AS job_result_json
        FROM document_pages p
        JOIN document_jobs j ON j.id = p.job_id AND j.user_id = p.user_id
        WHERE p.id = ? ${sourceModule ? 'AND j.source_module = ?' : ''}
    `, sourceModule ? [Number.parseInt(pageId, 10), sourceModule] : [Number.parseInt(pageId, 10)]);
    if (!page) return null;
    const access = await canAccessDocumentJob({ userId, jobId: page.job_id, sourceModule });
    if (!access) return null;
    await markReviewInProgress({ userId, jobId: page.job_id });
    const currentRevision = Math.max(Number(page.job_content_revision || 1), 1);
    const expected = Number.parseInt(expectedRevision, 10);
    if (Number.isSafeInteger(expected) && expected !== currentRevision) {
        const error = new Error('识别结果已被其他操作更新，请刷新后核对修改再保存。');
        error.status = 409;
        error.code = 'REVIEW_REVISION_CONFLICT';
        throw error;
    }
    const nextRevision = currentRevision + 1;
    const originalText = page.raw_text || page.text || '';
    const effectiveText = String(revisedText || '').slice(0, 1000000);
    const alignmentStatus = effectiveText === originalText ? 'aligned' : 'unaligned';
    const now = getBeijingTimestamp();
    const existing = await queryOne('SELECT * FROM document_reviews WHERE page_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1', [page.id, userId]);
    if (existing) {
        await execute(`
            UPDATE document_reviews
            SET review_status = ?, revised_text = ?, low_confidence_confirmed = ?, reviewed_at = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [reviewStatus, effectiveText, lowConfidenceConfirmed ? 1 : 0, now, now, existing.id, userId]);
    } else {
        await execute(`
            INSERT INTO document_reviews (
                user_id, file_id, job_id, page_id, review_status, original_text, revised_text, low_confidence_confirmed, reviewed_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [userId, page.file_id, page.job_id, page.id, reviewStatus, originalText, effectiveText, lowConfidenceConfirmed ? 1 : 0, now, now, now]);
    }
    await updatePageText({
        pageId: page.id,
        text: effectiveText,
        ocrStatus: reviewStatus,
        processingState: JOB_STATUSES.SUCCEEDED,
        confidence: page.confidence,
        result: { ...parseJson(page.result_json, {}), reviewed: true, humanVerified: Boolean(lowConfidenceConfirmed) },
        contentRevision: nextRevision,
        alignmentStatus
    });
    await execute(`
        INSERT INTO document_page_revisions (
            user_id, file_id, job_id, page_id, revision, base_revision, source_kind, raw_text, effective_text,
            alignment_status, review_status, low_confidence_confirmed, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [userId, page.file_id, page.job_id, page.id, nextRevision, currentRevision, 'review', originalText, effectiveText, alignmentStatus, reviewStatus, lowConfidenceConfirmed ? 1 : 0, now]);
    if (alignmentStatus === 'unaligned') {
        await execute(`
            UPDATE document_ocr_blocks
            SET effective_text = '', alignment_status = ?, result_revision = ?, updated_at = ?
            WHERE page_id = ? AND user_id = ?
        `, ['unaligned', nextRevision, now, page.id, page.user_id]);
    } else {
        await execute(`
            UPDATE document_ocr_blocks
            SET effective_text = raw_text, alignment_status = ?, result_revision = ?, updated_at = ?
            WHERE page_id = ? AND user_id = ?
        `, ['aligned', nextRevision, now, page.id, page.user_id]);
    }
    const reviewPending = await queryOne(`
        SELECT COUNT(*) AS count
        FROM document_pages
        WHERE job_id = ? AND (ocr_status IN (?, ?, ?) OR processing_state IN (?, ?, ?))
    `, [page.job_id, JOB_STATUSES.NEEDS_REVIEW, JOB_STATUSES.FAILED, 'pending', 'pending', JOB_STATUSES.PROCESSING, JOB_STATUSES.FAILED]);
    const unresolvedCount = Number(reviewPending?.count || 0);
    const assignmentCount = await queryOne(`
        SELECT COUNT(*) AS count FROM document_review_assignments
        WHERE job_id = ? AND status IN ('assigned', 'in_review', 'approved')
    `, [page.job_id]);
    const requiresAssignedReview = Number(assignmentCount?.count || 0) > 0;
    const nextReviewState = unresolvedCount === 0 && !requiresAssignedReview ? 'reviewed' : 'pending';
    const result = { ...parseJson(page.job_result_json, {}), reviewed: unresolvedCount === 0, contentRevision: nextRevision };
    await execute(`
        UPDATE document_jobs
        SET content_revision = ?, review_state = ?, result_json = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
    `, [nextRevision, nextReviewState, safeJson(result), now, page.job_id, page.user_id]);
    const job = await getJobRow(page.job_id);
    if (job && job.status === JOB_STATUSES.NEEDS_REVIEW && unresolvedCount === 0 && !requiresAssignedReview && Boolean(job.coverage_complete)) {
        await setJobStatus(job.id, JOB_STATUSES.SUCCEEDED, { progress: 100, result });
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
    getExportRequest: exportActions.getExportRequest,
    dispatchPdfJobResult: distribution.dispatchPdfJobResult,
    createOcrRegionCandidate: ocrRegions.createRegionCandidate,
    submitOcrFeedback: ocrFeedback.submitFeedback,
    listOcrFeedback: ocrFeedback.listFeedback,
    reviewOcrFeedback: ocrFeedback.reviewFeedback,
    extractOcrFields,
    shareJobResult: distribution.shareJobResult,
    createJobFromUpload,
    createOcrBatchFromUploads: ocrOperations.createOcrBatchFromUploads,
    createPdfToolJobFromUploads,
    deleteJob,
    enqueueJob,
    getDocumentProcessingSettings,
    getDocumentProcessingStats: monitoring.getDocumentProcessingStats,
    getJobDetail,
    getJobPageSlice,
    getPageRevisions,
    getOcrChatContext,
    getJobOutputsArchive,
    getJobOutputsArchiveStream,
    getOutputDownload,
    getPageImage,
    getQueueStatus,
    listOcrRegionCandidates: ocrRegions.listRegionCandidates,
    listJobs,
    processJob,
    preflightOcrUploads: ocrOperations.preflightOcrUploads,
    recoverDocumentProcessingJobs,
    requestJobExport: exportActions.requestJobExport,
    retryJob,
    reprocessJob,
    updateDocumentProcessingSettings,
    savePageReview,
    serializeJob
};
