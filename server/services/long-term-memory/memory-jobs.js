const { query, queryOne, execute } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { KeyedConcurrencyGuard } = require('../concurrency');
const { getAccessibleModelAsync } = require('../models');
const {
    MEMORY_JOB_STATUS,
    DEFAULT_MEMORY_JOB_MAX_ATTEMPTS,
    MEMORY_JOB_STALE_LOCK_MINUTES,
    DEFAULT_COMPLETED_JOB_RETENTION_DAYS,
    normalizeScopeReference,
    normalizeSourceMessageIds,
    parseJsonArray
} = require('./memory-utils');
const { serializeMemoryJob, buildMemoryJobDedupeKey } = require('./memory-serialization');
const { assertMemoryWriteGate } = require('./memory-gate');

const extractionGuard = new KeyedConcurrencyGuard({
    maxConcurrent: Math.max(1, Number.parseInt(process.env.LONG_TERM_MEMORY_EXTRACTION_MAX_CONCURRENT, 10) || 2)
});

let runMemoryExtractionHandler = null;

function setRunMemoryExtractionHandler(handler) {
    runMemoryExtractionHandler = handler;
}

async function cancelMemoryExtractionJobs(userId, options = {}) {
    const now = getBeijingTimestamp();
    const where = ['user_id = ?', 'status = ?'];
    const params = [Number(userId), MEMORY_JOB_STATUS.queued];
    const sessionId = normalizeScopeReference(options.sessionId || options.session_id);
    if (sessionId) {
        where.push('session_id = ?');
        params.push(sessionId);
    }
    const changes = await execute(`
        UPDATE memory_extraction_jobs
        SET status = ?, locked_at = NULL, last_error = ?, completed_at = ?, updated_at = ?
        WHERE ${where.join(' AND ')}
    `, [MEMORY_JOB_STATUS.skipped, String(options.reason || 'MEMORY_REVOKED').slice(0, 100), now, now, ...params]);
    return { cancelled: changes };
}

async function enqueueMemoryExtractionJob({ userId, sessionId, messageIds = [], modelId = null } = {}) {
    const normalizedUser = Number(userId);
    if (!Number.isSafeInteger(normalizedUser) || normalizedUser <= 0) {
        return { queued: false, reason: 'missing_context' };
    }
    const gate = await assertMemoryWriteGate(normalizedUser);
    if (!gate.allowed) {
        return { queued: false, reason: gate.reason || 'disabled' };
    }
    const normalizedSessionId = normalizeScopeReference(sessionId);
    const normalizedIds = normalizeSourceMessageIds(messageIds);
    if (normalizedIds.length === 0) {
        return { queued: false, reason: 'missing_context' };
    }
    const dedupeKey = buildMemoryJobDedupeKey(normalizedSessionId, normalizedIds);
    const existing = await queryOne(`
        SELECT *
        FROM memory_extraction_jobs
        WHERE user_id = ? AND dedupe_key = ?
          AND status IN (?, ?)
        ORDER BY id DESC
        LIMIT 1
    `, [normalizedUser, dedupeKey, MEMORY_JOB_STATUS.queued, MEMORY_JOB_STATUS.running]);
    if (existing) {
        return {
            queued: true,
            deduped: true,
            job: serializeMemoryJob(existing),
            messageIds: normalizedIds
        };
    }
    const now = getBeijingTimestamp();
    const payload = JSON.stringify(normalizedIds);
    const model = modelId ? String(modelId).slice(0, 80) : null;
    const inserted = await queryOne(`
        INSERT INTO memory_extraction_jobs (
            user_id, session_id, message_ids, dedupe_key, model_id, memory_revision, status, attempts, max_attempts, next_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
        RETURNING *
    `, [
        normalizedUser,
        normalizedSessionId,
        payload,
        dedupeKey,
        model,
        gate.gate.revision,
        MEMORY_JOB_STATUS.queued,
        DEFAULT_MEMORY_JOB_MAX_ATTEMPTS,
        now,
        now,
        now
    ]);
    return {
        queued: true,
        job: serializeMemoryJob(inserted),
        messageIds: normalizedIds
    };
}

async function resolveMemoryJobUser(row) {
    if (!row?.user_id) return null;
    return (await queryOne('SELECT id, username, nickname, unit, role FROM users WHERE id = ?', [row.user_id])) || { id: row.user_id };
}

async function resolveMemoryJobModel(row, user) {
    if (!user?.id) return null;
    try {
        return await getAccessibleModelAsync(user, row.model_id || null);
    } catch (_) {
        return null;
    }
}

function triggerMemoryExtractionWorker() {
    setImmediate(() => {
        processMemoryExtractionJobs()
            .catch(() => {});
    });
}

async function scheduleMemoryExtraction({ userId, sessionId, messageIds = [], user = null, modelCfg = null, triggerWorker = true } = {}) {
    const queued = await enqueueMemoryExtractionJob({
        userId: user?.id || userId,
        sessionId,
        messageIds,
        modelId: modelCfg?.id || null
    });
    if (!queued.queued) {
        return { scheduled: false, queued: false, reason: queued.reason };
    }
    if (triggerWorker) triggerMemoryExtractionWorker();
    return {
        scheduled: true,
        queued: true,
        deduped: queued.deduped === true,
        job: queued.job,
        jobId: queued.job?.id || null,
        messageIds: queued.messageIds
    };
}

async function claimMemoryExtractionJobs(limit = 5) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 5, 20));
    const now = getBeijingTimestamp();
    const staleLockThreshold = getBeijingTimestamp(new Date(Date.now() - MEMORY_JOB_STALE_LOCK_MINUTES * 60 * 1000));
    return await query(`
        WITH candidate_jobs AS (
            SELECT id
            FROM memory_extraction_jobs
            WHERE (
                status = ?
                AND (next_run_at IS NULL OR next_run_at <= ?)
            ) OR (
                status = ?
                AND locked_at IS NOT NULL
                AND locked_at < ?
            )
            ORDER BY next_run_at ASC, id ASC
            LIMIT ?
            FOR UPDATE SKIP LOCKED
        )
        UPDATE memory_extraction_jobs j
        SET status = ?,
            locked_at = ?,
            attempts = j.attempts + 1,
            updated_at = ?
        FROM candidate_jobs c
        WHERE j.id = c.id
        RETURNING j.*
    `, [
        MEMORY_JOB_STATUS.queued,
        now,
        MEMORY_JOB_STATUS.running,
        staleLockThreshold,
        safeLimit,
        MEMORY_JOB_STATUS.running,
        now,
        now
    ]);
}

function nextMemoryJobRunAt(attempts) {
    const backoffSeconds = Math.min(300, Math.max(15, (2 ** Math.max(1, Number(attempts || 1))) * 10));
    return getBeijingTimestamp(new Date(Date.now() + backoffSeconds * 1000));
}

async function finishMemoryExtractionJob(jobId, status, fields = {}) {
    const now = getBeijingTimestamp();
    await execute(`
        UPDATE memory_extraction_jobs
        SET status = ?,
            locked_at = NULL,
            last_error = ?,
            result = ?,
            next_run_at = ?,
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
    `, [
        status,
        fields.lastError ? String(fields.lastError).slice(0, 1000) : null,
        fields.result ? JSON.stringify(fields.result) : null,
        fields.nextRunAt || null,
        [MEMORY_JOB_STATUS.succeeded, MEMORY_JOB_STATUS.failed, MEMORY_JOB_STATUS.skipped].includes(status) ? now : null,
        now,
        jobId
    ]);
}

async function processMemoryExtractionJob(row, options = {}) {
    const runExtraction = options.runMemoryExtraction || runMemoryExtractionHandler;
    if (typeof runExtraction !== 'function') throw new Error('runMemoryExtraction handler not configured');
    const user = await resolveMemoryJobUser(row);
    const modelCfg = await resolveMemoryJobModel(row, user);
    const result = await runExtraction({
        userId: row.user_id,
        sessionId: row.session_id,
        messageIds: parseJsonArray(row.message_ids),
        user,
        modelCfg,
        memoryRevision: Number(row.memory_revision || 0)
    });
    const finalStatus = result.skipped ? MEMORY_JOB_STATUS.skipped : MEMORY_JOB_STATUS.succeeded;
    await finishMemoryExtractionJob(row.id, finalStatus, { result });
    return result;
}

async function processMemoryExtractionJobs(options = {}) {
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 5, 20));
    const rows = await claimMemoryExtractionJobs(limit);
    const results = [];
    for (const row of rows) {
        const key = `${row.user_id}:${row.session_id}:${row.id}`;
        try {
            const result = await extractionGuard.run(key, () => processMemoryExtractionJob(row, options));
            results.push({ id: row.id, ok: true, result });
        } catch (err) {
            const latest = (await queryOne('SELECT attempts, max_attempts FROM memory_extraction_jobs WHERE id = ?', [row.id])) || row;
            const attempts = Number(latest.attempts || row.attempts || 1);
            const maxAttempts = Number(latest.max_attempts || DEFAULT_MEMORY_JOB_MAX_ATTEMPTS);
            const exhausted = attempts >= maxAttempts;
            await finishMemoryExtractionJob(row.id, exhausted ? MEMORY_JOB_STATUS.failed : MEMORY_JOB_STATUS.queued, {
                lastError: String(err.message || err).slice(0, 1000),
                nextRunAt: exhausted ? null : nextMemoryJobRunAt(attempts)
            });
            results.push({ id: row.id, ok: false, error: err.message || String(err), retry: !exhausted });
        }
    }
    return {
        claimed: rows.length,
        succeeded: results.filter(item => item.ok).length,
        failed: results.filter(item => !item.ok && !item.retry).length,
        retried: results.filter(item => item.retry).length,
        results
    };
}

async function listMemoryExtractionJobs(userId, options = {}) {
    const status = options.status ? String(options.status) : '';
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 20, 100));
    const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
    const where = ['user_id = ?'];
    const params = [userId];
    if (status && status !== 'all') {
        where.push('status = ?');
        params.push(status);
    }
    const rows = await query(`
        SELECT *
        FROM memory_extraction_jobs
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
    `, [...params, limit, offset]);
    const totalRow = await queryOne(`SELECT COUNT(*) AS count FROM memory_extraction_jobs WHERE ${where.join(' AND ')}`, params);
    return {
        total: Number(totalRow?.count || 0),
        jobs: rows.map(serializeMemoryJob)
    };
}

async function retryFailedMemoryExtractionJobs(userId, jobIds = []) {
    const ids = (Array.isArray(jobIds) ? jobIds : []).map(id => Number.parseInt(id, 10)).filter(id => Number.isSafeInteger(id) && id > 0);
    const now = getBeijingTimestamp();
    const where = ['user_id = ?', 'status = ?'];
    const params = [userId, MEMORY_JOB_STATUS.failed];
    if (ids.length > 0) {
        where.push(`id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
    }
    const changes = await execute(`
        UPDATE memory_extraction_jobs
        SET status = ?,
            locked_at = NULL,
            last_error = NULL,
            next_run_at = ?,
            updated_at = ?
        WHERE ${where.join(' AND ')}
    `, [MEMORY_JOB_STATUS.queued, now, now, ...params]);
    if (changes > 0) triggerMemoryExtractionWorker();
    return { queued: changes };
}

async function cleanupMemoryExtractionJobs(userId, options = {}) {
    const retentionDays = Math.max(1, Math.min(Number.parseInt(options.retentionDays, 10) || DEFAULT_COMPLETED_JOB_RETENTION_DAYS, 365));
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 1000, 5000));
    const cutoff = getBeijingTimestamp(new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000));
    const rows = await query(`
        SELECT id
        FROM memory_extraction_jobs
        WHERE user_id = ?
          AND status IN (?, ?, ?)
          AND COALESCE(completed_at, updated_at, created_at) < ?
        ORDER BY COALESCE(completed_at, updated_at, created_at) ASC, id ASC
        LIMIT ?
    `, [
        userId,
        MEMORY_JOB_STATUS.succeeded,
        MEMORY_JOB_STATUS.failed,
        MEMORY_JOB_STATUS.skipped,
        cutoff,
        limit
    ]);
    if (rows.length === 0) return { deleted: 0, cutoff, retentionDays };
    const ids = rows.map(row => row.id);
    const changes = await execute(`
        DELETE FROM memory_extraction_jobs
        WHERE user_id = ?
          AND id IN (${ids.map(() => '?').join(',')})
    `, [userId, ...ids]);
    return { deleted: changes, cutoff, retentionDays };
}

module.exports = {
    setRunMemoryExtractionHandler,
    cancelMemoryExtractionJobs,
    enqueueMemoryExtractionJob,
    scheduleMemoryExtraction,
    processMemoryExtractionJobs,
    listMemoryExtractionJobs,
    retryFailedMemoryExtractionJobs,
    cleanupMemoryExtractionJobs
};
