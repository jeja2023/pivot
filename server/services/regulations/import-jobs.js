const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { query, queryOne, execute, transaction } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { logger: defaultLogger } = require('../../logger');
const {
    createRegulationDocumentFromUpload,
    findRegulationDuplicateByHash,
    saveRegulationDocumentVersion
} = require('./mutations');
const { normalizeRegulationId, uploadRoot } = require('./shared');

function normalizePositiveInt(value, fallback = null, maximum = Number.MAX_SAFE_INTEGER) {
    const number = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(number) || number <= 0) return fallback;
    return Math.min(number, maximum);
}

function normalizeJobMode(value) {
    return String(value || '').toLowerCase() === 'version' ? 'version' : 'create';
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(String(value || ''));
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_error) {
        return fallback;
    }
}

function normalizeJob(row) {
    if (!row) return null;
    return {
        ...row,
        id: Number(row.id),
        userId: Number(row.user_id),
        documentId: normalizePositiveInt(row.document_id),
        versionId: normalizePositiveInt(row.version_id),
        progress: Number(row.progress || 0),
        attempts: Number(row.attempts || 0),
        maxAttempts: Number(row.max_attempts || 0),
        payload: parseJson(row.payload_json, {}),
        result: parseJson(row.result_json, {})
    };
}

function serializeRegulationImportJob(row) {
    const job = normalizeJob(row);
    if (!job) return null;
    return {
        id: job.id,
        userId: job.userId,
        documentId: job.documentId,
        versionId: job.versionId,
        documentTitle: job.document_title || '',
        sourceName: job.source_name || '',
        mode: job.mode,
        status: job.status,
        stage: job.stage,
        progress: job.progress,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        result: job.result,
        errorCode: String(job.error_code || ''),
        errorMessage: String(job.error_message || ''),
        completedAt: job.completed_at || null,
        createdAt: job.created_at || null,
        updatedAt: job.updated_at || null
    };
}

function retryTimestamp(now, attempts) {
    const waitMs = Math.min(15 * 60 * 1000, Math.pow(2, Math.max(0, Number(attempts || 1) - 1)) * 1000);
    return getBeijingTimestamp(new Date(new Date(now).getTime() + waitMs));
}

async function hashFile(filePath) {
    try {
        return crypto.createHash('sha256').update(await fs.promises.readFile(filePath)).digest('hex');
    } catch (_error) {
        return '';
    }
}

async function enqueueRegulationImportJob({ userId, file, metadata = {}, mode = 'create', documentId = null }) {
    const normalizedUserId = normalizePositiveInt(userId);
    const normalizedDocumentId = normalizeRegulationId(documentId);
    if (!normalizedUserId || !file?.path || !file?.originalname) {
        const error = new Error('导入任务缺少文件或操作者信息');
        error.statusCode = 400;
        throw error;
    }
    const sourcePath = path.resolve(file.path);
    const relative = path.relative(uploadRoot, sourcePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        const error = new Error('导入任务文件路径无效');
        error.statusCode = 400;
        throw error;
    }
    const safeMode = normalizeJobMode(mode);
    if (safeMode === 'version' && !normalizedDocumentId) {
        const error = new Error('追加版本任务必须指定法规文档');
        error.statusCode = 400;
        throw error;
    }
    const now = getBeijingTimestamp();
    const row = await queryOne(`
        INSERT INTO regulation_import_jobs (
            user_id, document_id, source_name, source_path, source_hash, mode, status, stage,
            progress, attempts, max_attempts, payload_json, result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'queued', 0, 0, 3, ?::jsonb, '{}'::jsonb, ?, ?)
        RETURNING *
    `, [
        normalizedUserId,
        normalizedDocumentId,
        String(file.originalname).slice(0, 255),
        sourcePath,
        await hashFile(sourcePath),
        safeMode,
        JSON.stringify({ metadata, mimetype: String(file.mimetype || '') }),
        now,
        now
    ]);
    return serializeRegulationImportJob(row);
}

async function listRegulationImportJobs({ userId, status = '', limit = 30, offset = 0 } = {}) {
    const normalizedUserId = normalizePositiveInt(userId);
    if (!normalizedUserId) return { data: [], total: 0, limit: 30, offset: 0 };
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 30, 1), 100);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const safeStatus = String(status || '').trim();
    const filters = ['j.user_id = ?'];
    const params = [normalizedUserId];
    if (['queued', 'running', 'retry_wait', 'completed', 'failed', 'cancelled'].includes(safeStatus)) {
        filters.push('j.status = ?');
        params.push(safeStatus);
    }
    const where = filters.join(' AND ');
    const totalRow = await queryOne(`SELECT COUNT(*) AS count FROM regulation_import_jobs j WHERE ${where}`, params);
    const rows = await query(`
        SELECT j.id, j.user_id, j.document_id, j.version_id, j.source_name, j.source_hash, j.mode,
               j.status, j.stage, j.progress, j.attempts, j.max_attempts, j.result_json,
               j.error_code, j.error_message, j.completed_at, j.created_at, j.updated_at,
               d.title AS document_title
        FROM regulation_import_jobs j
        LEFT JOIN regulation_documents d ON d.id = j.document_id
        WHERE ${where}
        ORDER BY j.created_at DESC, j.id DESC
        LIMIT ? OFFSET ?
    `, [...params, safeLimit, safeOffset]);
    return { data: rows.map(serializeRegulationImportJob), total: Number(totalRow?.count || 0), limit: safeLimit, offset: safeOffset };
}

async function cancelRegulationImportJob({ jobId, userId }) {
    const id = normalizePositiveInt(jobId);
    const uid = normalizePositiveInt(userId);
    if (!id || !uid) return null;
    const now = getBeijingTimestamp();
    // running 状态已可能进入文件落库临界区，不能宣称可以安全取消；仅取消还未被
    // worker 领取的任务，避免出现“显示已取消但实际已发布”的竞态。
    return await queryOne(`
        UPDATE regulation_import_jobs
        SET status = 'cancelled', stage = 'cancelled', locked_by = '', locked_at = NULL,
            error_code = 'REGULATION_IMPORT_CANCELLED', error_message = '导入任务已由用户取消。', updated_at = ?
        WHERE id = ? AND user_id = ? AND status IN ('queued', 'retry_wait')
        RETURNING *
    `, [now, id, uid]);
}

async function retryRegulationImportJob({ jobId, userId }) {
    const id = normalizePositiveInt(jobId);
    const uid = normalizePositiveInt(userId);
    if (!id || !uid) return null;
    const now = getBeijingTimestamp();
    return await queryOne(`
        UPDATE regulation_import_jobs
        SET status = 'queued', stage = 'queued', progress = 0, attempts = 0, next_retry_at = NULL,
            locked_by = '', locked_at = NULL, error_code = '', error_message = '', completed_at = NULL, updated_at = ?
        WHERE id = ? AND user_id = ? AND status IN ('failed', 'cancelled')
        RETURNING *
    `, [now, id, uid]);
}

async function claimNextRegulationImportJob({ workerId = `regulations-import-${process.pid}` } = {}) {
    const safeWorkerId = String(workerId).replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 120) || `regulations-import-${process.pid}`;
    return await transaction(async trx => {
        const now = getBeijingTimestamp();
        const row = await trx.queryOne(`
            SELECT *
            FROM regulation_import_jobs
            WHERE status IN ('queued', 'retry_wait')
              AND (next_retry_at IS NULL OR next_retry_at <= ?)
            ORDER BY created_at ASC, id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        `, [now]);
        if (!row) return null;
        const job = normalizeJob(row);
        const changed = await trx.execute(`
            UPDATE regulation_import_jobs
            SET status = 'running', stage = 'extracting', progress = 5, attempts = attempts + 1,
                locked_by = ?, locked_at = ?, error_code = '', error_message = '', updated_at = ?
            WHERE id = ? AND status IN ('queued', 'retry_wait')
        `, [safeWorkerId, now, now, job.id]);
        if (Number(changed || 0) !== 1) return null;
        return { ...job, status: 'running', stage: 'extracting', progress: 5, attempts: job.attempts + 1, lockedBy: safeWorkerId };
    });
}

async function updateRegulationImportJob(jobId, patch = {}) {
    const normalizedJobId = normalizePositiveInt(jobId);
    if (!normalizedJobId) return false;
    const stage = String(patch.stage || '').slice(0, 50);
    const progress = Number.isFinite(Number(patch.progress)) ? Math.min(Math.max(Number(patch.progress), 0), 100) : null;
    const changed = await execute(`
        UPDATE regulation_import_jobs
        SET stage = COALESCE(NULLIF(?, ''), stage),
            progress = COALESCE(?, progress), updated_at = ?
        WHERE id = ? AND status = 'running'
    `, [stage, progress, getBeijingTimestamp(), normalizedJobId]);
    return Number(changed || 0) > 0;
}

async function completeRegulationImportJob(jobId, result) {
    const normalizedJobId = normalizePositiveInt(jobId);
    if (!normalizedJobId) return false;
    const now = getBeijingTimestamp();
    const changed = await execute(`
        UPDATE regulation_import_jobs
        SET document_id = ?, version_id = ?, status = 'completed', stage = 'published', progress = 100,
            result_json = ?::jsonb, locked_by = '', locked_at = NULL, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running'
    `, [result.document?.id || null, result.version?.id || null, JSON.stringify(result), now, now, normalizedJobId]);
    return Number(changed || 0) > 0;
}

async function failRegulationImportJob(job, error) {
    const normalized = normalizeJob(job);
    if (!normalized?.id) return { status: 'missing' };
    const retryable = error?.retryable !== false && error?.statusCode !== 400 && error?.statusCode !== 422;
    const status = retryable && normalized.attempts < normalized.maxAttempts ? 'retry_wait' : 'failed';
    const now = getBeijingTimestamp();
    const nextRetryAt = status === 'retry_wait' ? retryTimestamp(now, normalized.attempts) : null;
    await execute(`
        UPDATE regulation_import_jobs
        SET status = ?, stage = 'failed', next_retry_at = ?, locked_by = '', locked_at = NULL,
            error_code = ?, error_message = ?, updated_at = ?
        WHERE id = ? AND status = 'running'
    `, [
        status,
        nextRetryAt,
        String(error?.code || 'REGULATION_IMPORT_FAILED').slice(0, 80),
        String(error?.message || '法规导入失败').slice(0, 1500),
        now,
        normalized.id
    ]);
    return { status, retryAt: nextRetryAt };
}

async function recoverRegulationImportJobs({ leaseSeconds = 180, limit = 100 } = {}) {
    const safeLeaseSeconds = Math.min(Math.max(Number.parseInt(leaseSeconds, 10) || 180, 30), 3600);
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 1000);
    const now = getBeijingTimestamp();
    const rows = await query(`
        SELECT * FROM regulation_import_jobs
        WHERE status = 'running'
          AND locked_at < ((now() AT TIME ZONE 'Asia/Shanghai') - (?::text || ' seconds')::interval)
        ORDER BY locked_at ASC LIMIT ?
    `, [safeLeaseSeconds, safeLimit]);
    let recovered = 0;
    for (const row of rows) {
        const job = normalizeJob(row);
        const retry = job.attempts < job.maxAttempts;
        const changed = await execute(`
            UPDATE regulation_import_jobs
            SET status = ?, stage = ?, next_retry_at = ?, locked_by = '', locked_at = NULL,
                error_code = 'REGULATION_IMPORT_LEASE_EXPIRED', error_message = '导入任务租约已过期，任务已由系统恢复。', updated_at = ?
            WHERE id = ? AND status = 'running'
        `, [retry ? 'retry_wait' : 'failed', retry ? 'queued' : 'failed', retry ? retryTimestamp(now, job.attempts) : null, now, job.id]);
        recovered += Number(changed || 0);
    }
    return { recovered, scanned: rows.length };
}

async function processRegulationImportJob(job) {
    const normalized = normalizeJob(job);
    if (!normalized || !normalized.source_path) throw Object.assign(new Error('导入任务源文件不存在'), { retryable: false });
    const sourceExists = await fs.promises.access(normalized.source_path).then(() => true).catch(() => false);
    if (!sourceExists) throw Object.assign(new Error('导入任务源文件已丢失，请重新上传'), { retryable: false });
    await updateRegulationImportJob(normalized.id, { stage: 'publishing', progress: 55 });
    const file = {
        path: normalized.source_path,
        originalname: normalized.source_name,
        mimetype: normalized.payload.mimetype || ''
    };
    const metadata = normalized.payload.metadata || {};
    const duplicateOf = normalized.source_hash ? await findRegulationDuplicateByHash(normalized.source_hash) : null;
    const result = normalized.mode === 'version'
        ? await saveRegulationDocumentVersion({ documentId: normalized.documentId, userId: normalized.userId, file, metadata, providedTitle: metadata.title || '', preloadedText: '' })
        : await createRegulationDocumentFromUpload({ userId: normalized.userId, file, metadata, preloadedText: '' });
    const payload = {
        document: result.document ? { id: result.document.id, title: result.document.title } : null,
        version: result.version ? { id: result.version.id, version_label: result.version.version_label } : null,
        articleCount: Number(result.version?.article_count || result.articles?.length || 0),
        sourceName: normalized.source_name,
        duplicateOf: duplicateOf || null
    };
    await completeRegulationImportJob(normalized.id, payload);
    return payload;
}

function createRegulationImportWorker({
    workerId = `regulations-import-${process.pid}`,
    pollIntervalMs = 1000,
    logger = defaultLogger,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    recoverJobs = recoverRegulationImportJobs,
    claimJob = claimNextRegulationImportJob,
    processJob = processRegulationImportJob,
    failJob = failRegulationImportJob
} = {}) {
    let started = false;
    let running = false;
    let timer = null;
    let startupTask = null;
    let drainTask = null;
    let recoveryTask = null;
    let shutdownRequested = false;
    function recover() {
        if (recoveryTask) return recoveryTask;
        const task = Promise.resolve().then(() => recoverJobs());
        recoveryTask = task;
        task.then(() => { if (recoveryTask === task) recoveryTask = null; }, () => { if (recoveryTask === task) recoveryTask = null; });
        return task;
    }
    async function drainWork() {
        if (!started || running) return;
        running = true;
        try {
            while (started) {
                const job = await claimJob({ workerId });
                if (!job) break;
                try {
                    await processJob(job);
                } catch (error) {
                    const result = await failJob(job, error);
                    logger.warn({ err: error.message, jobId: job.id, status: result.status }, '法规导入任务执行失败');
                }
            }
        } finally {
            running = false;
        }
    }
    function drain() {
        if (drainTask) return drainTask;
        const task = Promise.resolve().then(drainWork);
        drainTask = task;
        task.then(() => { if (drainTask === task) drainTask = null; }, () => { if (drainTask === task) drainTask = null; });
        return task;
    }
    function start() {
        if (started || shutdownRequested) return Promise.resolve({ started, running });
        started = true;
        const task = (async () => {
            await recover();
            if (!started || shutdownRequested) return { started, running };
            timer = setIntervalFn(() => {
                void recover().catch(error => logger.warn({ err: error.message }, '法规导入租约恢复失败'));
                void drain().catch(error => logger.warn({ err: error.message }, '法规导入任务调度失败'));
            }, Math.max(500, Number(pollIntervalMs) || 1000));
            timer?.unref?.();
            await drain();
            return { started, running };
        })().catch(error => { started = false; if (timer) clearIntervalFn(timer); timer = null; throw error; });
        startupTask = task;
        task.then(() => { if (startupTask === task) startupTask = null; }, () => { if (startupTask === task) startupTask = null; });
        return task;
    }
    async function stop() {
        started = false;
        if (timer) clearIntervalFn(timer);
        timer = null;
        await Promise.allSettled([startupTask, drainTask, recoveryTask].filter(Boolean));
    }
    async function shutdown() { shutdownRequested = true; await stop(); }
    return { start, stop, shutdown, drain, getRuntimeStatus: () => ({ started, running, workerId }) };
}

let regulationImportWorker = null;
let regulationImportShuttingDown = false;
async function startRegulationImportWorker() {
    if (regulationImportShuttingDown) return { started: false, running: false };
    if (!regulationImportWorker) regulationImportWorker = createRegulationImportWorker();
    return await regulationImportWorker.start();
}

async function shutdownRegulationImportWorker() {
    regulationImportShuttingDown = true;
    if (regulationImportWorker) await regulationImportWorker.shutdown();
}

module.exports = {
    cancelRegulationImportJob,
    claimNextRegulationImportJob,
    createRegulationImportWorker,
    enqueueRegulationImportJob,
    failRegulationImportJob,
    listRegulationImportJobs,
    processRegulationImportJob,
    retryRegulationImportJob,
    startRegulationImportWorker,
    shutdownRegulationImportWorker,
    updateRegulationImportJob
};
