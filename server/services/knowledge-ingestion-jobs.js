'use strict';

// 可恢复的知识库索引任务队列。
//
// 队列状态只存在数据库中，进程内 worker 只负责争抢带租约的任务。因此服务
// 重启和多实例部署不会丢失任务，也不会因为每个实例各自维护 Map/Set 而重复索引。
const crypto = require('crypto');
const { query, queryOne, execute, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { logger: defaultLogger } = require('../logger');

const ACTIVE_STATUSES = Object.freeze(['queued', 'running', 'retry_wait']);
const CLAIMABLE_STATUSES = Object.freeze(['queued', 'retry_wait']);
const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);

function normalizePositiveInt(value, fallback = null, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
}

function normalizePriority(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(-100, Math.min(parsed, 100));
}

function normalizeWorkerId(value) {
    const source = String(value || '').trim().replace(/[^A-Za-z0-9._:-]/g, '');
    return source.slice(0, 120) || `knowledge-worker-${process.pid}`;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(String(value || ''));
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function normalizeJob(row) {
    if (!row) return null;
    return {
        ...row,
        id: Number(row.id),
        docId: Number(row.doc_id),
        userId: Number(row.user_id),
        sourceId: normalizePositiveInt(row.source_id),
        documentId: normalizePositiveInt(row.document_id),
        versionId: normalizePositiveInt(row.version_id),
        priority: Number(row.priority || 0),
        attempts: Number(row.attempts || 0),
        maxAttempts: Number(row.max_attempts || 0),
        payload: parseJson(row.payload_json, {}),
        errorCode: String(row.error_code || ''),
        errorMessage: String(row.error_message || '')
    };
}

function retryDelayMs(attempts) {
    const exponential = Math.max(1, Math.pow(2, Math.max(0, Number(attempts || 1) - 1))) * 1000;
    // 最多 15 分钟，避免临时依赖故障导致高频重试和日志风暴。
    return Math.min(exponential, 15 * 60 * 1000);
}

function retryTimestamp(now, attempts) {
    return getBeijingTimestamp(new Date(new Date(now).getTime() + retryDelayMs(attempts)));
}

function createKnowledgeIngestionQueue(deps = {}) {
    const queryFn = deps.query || query;
    const queryOneFn = deps.queryOne || queryOne;
    const executeFn = deps.execute || execute;
    const transactionFn = deps.transaction || transaction;
    const now = deps.now || getBeijingTimestamp;
    const randomUuid = deps.randomUUID || crypto.randomUUID;

    async function findActiveJob(docId, jobType = 'index') {
        const row = await queryOneFn(`
            SELECT *
            FROM knowledge_ingestion_jobs
            WHERE doc_id = ?
              AND job_type = ?
              AND status IN ('queued', 'running', 'retry_wait')
            ORDER BY priority DESC, id ASC
            LIMIT 1
        `, [docId, jobType]);
        return normalizeJob(row);
    }

    async function enqueue({
        docId,
        userId,
        sourceId = null,
        documentId = null,
        versionId = null,
        jobType = 'index',
        priority = 0,
        maxAttempts = 5,
        payload = {}
    } = {}) {
        const normalizedDocId = normalizePositiveInt(docId);
        const normalizedUserId = normalizePositiveInt(userId);
        if (!normalizedDocId || !normalizedUserId) {
            return { started: false, reason: 'invalid_job_target', job: null };
        }
        const safeType = String(jobType || 'index').trim().slice(0, 40) || 'index';
        const active = await findActiveJob(normalizedDocId, safeType);
        if (active) return { started: false, reason: 'already_processing', job: active };

        const timestamp = now();
        const key = `${safeType}:${normalizedDocId}:${randomUuid()}`;
        const row = await queryOneFn(`
            INSERT INTO knowledge_ingestion_jobs (
                doc_id, user_id, source_id, document_id, version_id, job_type, stage,
                status, priority, attempts, max_attempts, idempotency_key, payload_json,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, 0, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING
            RETURNING *
        `, [
            normalizedDocId,
            normalizedUserId,
            normalizePositiveInt(sourceId),
            normalizePositiveInt(documentId),
            normalizePositiveInt(versionId),
            safeType,
            normalizePriority(priority),
            normalizePositiveInt(maxAttempts, 5, 20),
            key,
            JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
            timestamp,
            timestamp
        ]);
        if (row) return { started: true, reason: 'queued', job: normalizeJob(row) };

        // 并发请求可能在上方 active 查询后插入。唯一活动任务索引会挡住
        // 第二个插入，此时返回已有任务，保证 API 幂等。
        const concurrent = await findActiveJob(normalizedDocId, safeType);
        return { started: false, reason: concurrent ? 'already_processing' : 'enqueue_conflict', job: concurrent };
    }

    async function claimNext({ workerId, leaseSeconds = 120 } = {}) {
        const safeWorkerId = normalizeWorkerId(workerId);
        const safeLeaseSeconds = Math.max(15, Math.min(Number.parseInt(leaseSeconds, 10) || 120, 3600));
        return await transactionFn(async trx => {
            const currentTime = now();
            const row = await trx.queryOne(`
                SELECT *
                FROM knowledge_ingestion_jobs
                WHERE status IN ('queued', 'retry_wait')
                  AND (next_retry_at IS NULL OR next_retry_at <= ?)
                ORDER BY priority DESC, created_at ASC, id ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            `, [currentTime]);
            if (!row) return null;
            const job = normalizeJob(row);
            const changed = await trx.execute(`
                UPDATE knowledge_ingestion_jobs
                SET status = 'running', stage = CASE WHEN stage = 'queued' THEN 'claimed' ELSE stage END,
                    attempts = attempts + 1, locked_by = ?, locked_at = ?, updated_at = ?,
                    error_code = '', error_message = ''
                WHERE id = ? AND status IN ('queued', 'retry_wait')
            `, [safeWorkerId, currentTime, currentTime, job.id]);
            if (Number(changed || 0) !== 1) return null;
            return {
                ...job,
                status: 'running',
                stage: job.stage === 'queued' ? 'claimed' : job.stage,
                attempts: job.attempts + 1,
                locked_by: safeWorkerId,
                locked_at: currentTime,
                leaseSeconds: safeLeaseSeconds
            };
        });
    }

    async function updateStage(jobId, stage) {
        const id = normalizePositiveInt(jobId);
        const safeStage = String(stage || '').trim().slice(0, 50);
        if (!id || !safeStage) return false;
        const changed = await executeFn(`
            UPDATE knowledge_ingestion_jobs
            SET stage = ?, updated_at = ?
            WHERE id = ? AND status = 'running'
        `, [safeStage, now(), id]);
        return Number(changed || 0) > 0;
    }

    async function renewLease(jobId, workerId) {
        const id = normalizePositiveInt(jobId);
        const safeWorkerId = normalizeWorkerId(workerId);
        if (!id) return false;
        const changed = await executeFn(`
            UPDATE knowledge_ingestion_jobs
            SET locked_at = ?, updated_at = ?
            WHERE id = ? AND status = 'running' AND locked_by = ?
        `, [now(), now(), id, safeWorkerId]);
        return Number(changed || 0) > 0;
    }

    async function complete(jobId, { stage = 'published', payload = null } = {}) {
        const id = normalizePositiveInt(jobId);
        if (!id) return false;
        const timestamp = now();
        const changed = await executeFn(`
            UPDATE knowledge_ingestion_jobs
            SET status = 'completed', stage = ?, payload_json = COALESCE(?, payload_json),
                completed_at = ?, locked_by = '', locked_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'running'
        `, [
            String(stage || 'published').slice(0, 50),
            payload && typeof payload === 'object' ? JSON.stringify(payload) : null,
            timestamp,
            timestamp,
            id
        ]);
        return Number(changed || 0) > 0;
    }

    async function fail(job, error, { retryable = true, stage = 'failed' } = {}) {
        const normalized = normalizeJob(job);
        if (!normalized?.id) return { status: 'missing', retryAt: null };
        const timestamp = now();
        const code = String(error?.code || error?.name || 'KNOWLEDGE_INGESTION_FAILED').slice(0, 80);
        const message = String(error?.message || error || '知识库索引失败').slice(0, 1500);
        const willRetry = retryable && normalized.attempts < normalized.maxAttempts;
        const nextRetryAt = willRetry ? retryTimestamp(timestamp, normalized.attempts) : null;
        const status = willRetry ? 'retry_wait' : 'failed';
        const changed = await executeFn(`
            UPDATE knowledge_ingestion_jobs
            SET status = ?, stage = ?, next_retry_at = ?, locked_by = '', locked_at = NULL,
                error_code = ?, error_message = ?, updated_at = ?
            WHERE id = ? AND status = 'running'
        `, [status, String(stage || 'failed').slice(0, 50), nextRetryAt, code, message, timestamp, normalized.id]);
        return {
            status: Number(changed || 0) > 0 ? status : 'unchanged',
            retryAt: nextRetryAt,
            attempts: normalized.attempts,
            maxAttempts: normalized.maxAttempts
        };
    }

    async function recoverExpiredLeases({ leaseSeconds = 120, limit = 200 } = {}) {
        const safeLeaseSeconds = Math.max(15, Math.min(Number.parseInt(leaseSeconds, 10) || 120, 3600));
        const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 200, 2000));
        let requeued = 0;
        let failed = 0;
        const scanned = await transactionFn(async trx => {
            const rows = await trx.query(`
                SELECT id, attempts, max_attempts
                FROM knowledge_ingestion_jobs
                WHERE status = 'running'
                  AND locked_at < ((now() AT TIME ZONE 'Asia/Shanghai') - (?::text || ' seconds')::interval)
                ORDER BY locked_at ASC
                LIMIT ?
                FOR UPDATE SKIP LOCKED
            `, [safeLeaseSeconds, safeLimit]);
            for (const row of rows || []) {
                const attempts = Number(row.attempts || 0);
                const maxAttempts = Number(row.max_attempts || 0);
                const retry = attempts < maxAttempts;
                const status = retry ? 'retry_wait' : 'failed';
                const timestamp = now();
                const changed = await trx.execute(`
                    UPDATE knowledge_ingestion_jobs
                    SET status = ?, stage = ?, next_retry_at = ?, locked_by = '', locked_at = NULL,
                        error_code = 'KNOWLEDGE_JOB_LEASE_EXPIRED',
                        error_message = '索引 Worker 租约已过期，任务已由系统恢复。', updated_at = ?
                    WHERE id = ? AND status = 'running'
                `, [
                    status,
                    retry ? 'queued' : 'failed',
                    retry ? retryTimestamp(timestamp, attempts) : null,
                    timestamp,
                    row.id
                ]);
                if (Number(changed || 0) > 0) {
                    if (retry) requeued += 1;
                    else failed += 1;
                }
            }
            return (rows || []).length;
        });
        return { scanned, requeued, failed };
    }

    async function cancelQueuedForDocument(docId, userId = null) {
        const normalizedDocId = normalizePositiveInt(docId);
        if (!normalizedDocId) return 0;
        const params = [now(), normalizedDocId];
        let ownerSql = '';
        if (normalizePositiveInt(userId)) {
            ownerSql = ' AND user_id = ?';
            params.push(normalizePositiveInt(userId));
        }
        const changed = await executeFn(`
            UPDATE knowledge_ingestion_jobs
            SET status = 'cancelled', stage = 'cancelled', locked_by = '', locked_at = NULL,
                completed_at = ?, updated_at = ?
            WHERE doc_id = ? AND status IN ('queued', 'retry_wait')${ownerSql}
        `, [now(), ...params]);
        return Number(changed || 0);
    }

    async function getStatus(userId = null) {
        const normalizedUserId = normalizePositiveInt(userId);
        const params = normalizedUserId ? [normalizedUserId] : [];
        const userWhere = normalizedUserId ? 'WHERE user_id = ?' : '';
        const rows = await queryFn(`
            SELECT status, COUNT(*) AS count
            FROM knowledge_ingestion_jobs
            ${userWhere}
            GROUP BY status
        `, params);
        const totals = Object.fromEntries((rows || []).map(row => [row.status, Number(row.count || 0)]));
        const active = ACTIVE_STATUSES.reduce((sum, status) => sum + Number(totals[status] || 0), 0);
        const queued = Number(totals.queued || 0) + Number(totals.retry_wait || 0);
        return {
            active,
            running: Number(totals.running || 0),
            pending: queued,
            retryWaiting: Number(totals.retry_wait || 0),
            completed: Number(totals.completed || 0),
            failed: Number(totals.failed || 0),
            cancelled: Number(totals.cancelled || 0),
            statuses: totals
        };
    }

    return {
        ACTIVE_STATUSES,
        CLAIMABLE_STATUSES,
        TERMINAL_STATUSES,
        cancelQueuedForDocument,
        claimNext,
        complete,
        enqueue,
        fail,
        findActiveJob,
        getStatus,
        recoverExpiredLeases,
        renewLease,
        updateStage
    };
}

function createKnowledgeIngestionWorker({
    queue = createKnowledgeIngestionQueue(),
    processJob,
    getConcurrency = () => 1,
    workerId = `knowledge-worker-${process.pid}`,
    pollIntervalMs = 1000,
    leaseSeconds = 120,
    logger = defaultLogger,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
} = {}) {
    if (typeof processJob !== 'function') throw new TypeError('知识库索引 Worker 必须提供 processJob(job)');
    let started = false;
    let draining = false;
    let running = 0;
    let timer = null;

    const maxConcurrency = () => Math.max(1, Math.min(Number.parseInt(getConcurrency(), 10) || 1, 64));

    async function runJob(job) {
        const heartbeatMs = Math.max(1000, Math.floor(Math.max(15, Number(leaseSeconds) || 120) * 1000 / 3));
        const heartbeat = setIntervalFn(() => {
            void queue.renewLease(job.id, workerId).catch(error => logger.warn({ err: error.message, jobId: job.id }, '知识库索引任务租约续期失败'));
        }, heartbeatMs);
        heartbeat?.unref?.();
        try {
            await queue.updateStage(job.id, 'indexing');
            const result = await processJob(job);
            await queue.complete(job.id, { stage: result?.stage || 'published', payload: result || {} });
        } catch (error) {
            const failure = await queue.fail(job, error, { retryable: error?.retryable !== false });
            logger.warn({
                err: error?.message,
                jobId: job.id,
                docId: job.docId,
                status: failure.status,
                retryAt: failure.retryAt
            }, '知识库持久化索引任务执行失败');
        } finally {
            clearIntervalFn(heartbeat);
            running = Math.max(0, running - 1);
            kick().catch(error => logger.warn({ err: error.message, jobId: job.id }, '知识库索引任务后续调度失败'));
        }
    }

    async function drain() {
        if (draining || !started) return;
        draining = true;
        try {
            while (started && running < maxConcurrency()) {
                const job = await queue.claimNext({ workerId, leaseSeconds });
                if (!job) break;
                running += 1;
                runJob(job).catch(error => logger.warn({ err: error.message, jobId: job.id }, '知识库索引任务执行出现未处理错误'));
            }
        } catch (error) {
            logger.warn({ err: error.message }, '知识库索引 Worker 领取任务失败');
        } finally {
            draining = false;
        }
    }

    async function kick() {
        await drain();
    }

    async function start() {
        if (started) return getRuntimeStatus();
        started = true;
        await queue.recoverExpiredLeases({ leaseSeconds });
        timer = setIntervalFn(() => {
            // 每轮先回收真正失去心跳的任务，再领取可运行任务。实际执行中的
            // Worker 会按 lease 的三分之一刷新 locked_at，避免长文档被抢占。
            void queue.recoverExpiredLeases({ leaseSeconds }).catch(error => logger.warn({ err: error.message }, '知识库索引任务租约恢复失败'));
            void kick();
        }, Math.max(250, Number(pollIntervalMs) || 1000));
        timer?.unref?.();
        await kick();
        return getRuntimeStatus();
    }

    function stop() {
        started = false;
        if (timer) clearIntervalFn(timer);
        timer = null;
    }

    function getRuntimeStatus() {
        return { started, running, maxConcurrent: maxConcurrency(), workerId: normalizeWorkerId(workerId) };
    }

    return { getRuntimeStatus, kick, start, stop };
}

module.exports = {
    ACTIVE_STATUSES,
    TERMINAL_STATUSES,
    createKnowledgeIngestionQueue,
    createKnowledgeIngestionWorker,
    retryDelayMs
};
