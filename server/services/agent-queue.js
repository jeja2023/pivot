const DEFAULT_LOCK_MS = 24 * 60 * 60 * 1000;

function createAgentQueue({
    db,
    logger,
    instanceId,
    maxConcurrent,
    maxConcurrentPerUser = 2,
    lockMs = DEFAULT_LOCK_MS,
    getRunUser,
    runAgent,
    markRunError,
    getTimestamp
}) {
    const activeRunIds = new Set();
    const activeStartedAt = new Map();
    const lockRenewTimers = new Map();
    const queuedHints = new Set();
    const activeUserCounts = new Map();
    let processScheduled = false;
    let safeMaxConcurrent = Math.max(Number.parseInt(maxConcurrent, 10) || 1, 1);
    const safeMaxConcurrentPerUser = Math.max(Number.parseInt(maxConcurrentPerUser, 10) || 2, 1);
    const safeLockMs = Math.max(Number.parseInt(lockMs, 10) || DEFAULT_LOCK_MS, 60000);
    const lockRenewIntervalMs = Math.min(Math.max(Math.floor(safeLockMs / 3), 30000), 300000);

    const lockExpiresAt = () => getTimestamp(new Date(Date.now() + safeLockMs));

    function scheduleProcessQueue() {
        if (processScheduled) return;
        processScheduled = true;
        setImmediate(() => {
            processScheduled = false;
            processQueue();
        });
    }

    function claimNextRun() {
        const rows = db.prepare(`
            SELECT id, user_id
            FROM agent_runs
            WHERE status = 'queued'
              AND deleted_at IS NULL
              AND (
                  locked_by IS NULL
                  OR lock_expires_at IS NULL
                  OR lock_expires_at <= datetime('now', '+8 hours')
              )
            ORDER BY priority DESC, created_at ASC
            LIMIT 50
        `).all();

        for (const row of rows) {
            if ((activeUserCounts.get(row.user_id) || 0) >= safeMaxConcurrentPerUser) continue;
            const now = getTimestamp();
            const result = db.prepare(`
                UPDATE agent_runs
                SET status = 'running',
                    locked_by = ?,
                    lock_expires_at = ?,
                    started_at = COALESCE(started_at, ?),
                    last_heartbeat_at = ?,
                    updated_at = ?
                WHERE id = ?
                  AND status = 'queued'
                  AND deleted_at IS NULL
                  AND (
                      locked_by IS NULL
                      OR lock_expires_at IS NULL
                      OR lock_expires_at <= datetime('now', '+8 hours')
                  )
            `).run(instanceId, lockExpiresAt(), now, now, now, row.id);

            if (result.changes === 1) return row;
        }

        return null;
    }

    function renewRunLock(runId) {
        const now = getTimestamp();
        const result = db.prepare(`
            UPDATE agent_runs
            SET lock_expires_at = ?,
                last_heartbeat_at = ?,
                updated_at = ?
            WHERE id = ?
              AND locked_by = ?
              AND status = 'running'
              AND deleted_at IS NULL
        `).run(lockExpiresAt(), now, now, runId, instanceId);
        if (result.changes === 0) {
            logger.warn({ runId, instanceId }, 'Agent run lock renewal skipped; lock owner or status changed');
        }
        return result.changes;
    }

    function stopLockRenewal(runId) {
        const timer = lockRenewTimers.get(runId);
        if (timer) clearInterval(timer);
        lockRenewTimers.delete(runId);
    }

    function startLockRenewal(runId) {
        stopLockRenewal(runId);
        const timer = setInterval(() => {
            try {
                renewRunLock(runId);
            } catch (err) {
                logger.warn({ err: err.message, runId }, 'Agent run lock renewal failed');
            }
        }, lockRenewIntervalMs);
        timer.unref?.();
        lockRenewTimers.set(runId, timer);
    }
    function releaseRun(runId) {
        db.prepare(`
            UPDATE agent_runs
            SET locked_by = NULL,
                lock_expires_at = NULL
            WHERE id = ? AND locked_by = ?
        `).run(runId, instanceId);
    }

    function processQueue() {
        while (activeRunIds.size < safeMaxConcurrent) {
            const claimed = claimNextRun();
            if (!claimed || activeRunIds.has(claimed.id)) break;
            const runId = claimed.id;
            const user = getRunUser(runId);
            if (!user) {
                const status = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId)?.status;
                if (!['cancelled', 'deleted', 'error', 'completed', 'completed_with_errors'].includes(status)) {
                    markRunError(runId, 'Agent run user no longer exists.');
                }
                releaseRun(runId);
                continue;
            }

            activeRunIds.add(runId);
            activeUserCounts.set(user.id, (activeUserCounts.get(user.id) || 0) + 1);
            activeStartedAt.set(runId, Date.now());
            startLockRenewal(runId);
            queuedHints.delete(runId);
            runAgent(runId, user).catch(err => {
                logger.error({ err: err.message, runId }, 'Agent run failed while protected by runtime lock');
                markRunError(runId, err.message);
            }).finally(() => {
                activeRunIds.delete(runId);
                const nextUserCount = Math.max((activeUserCounts.get(user.id) || 1) - 1, 0);
                if (nextUserCount === 0) activeUserCounts.delete(user.id);
                else activeUserCounts.set(user.id, nextUserCount);
                activeStartedAt.delete(runId);
                stopLockRenewal(runId);
                releaseRun(runId);
                scheduleProcessQueue();
            });
        }
    }

    function enqueueRun(runId) {
        if (runId) queuedHints.add(runId);
        scheduleProcessQueue();
    }

    function recoverQueued(limit = 100) {
        const queued = db.prepare(`
            SELECT id
            FROM agent_runs
            WHERE status = 'queued'
              AND deleted_at IS NULL
            ORDER BY priority DESC, created_at ASC
            LIMIT ?
        `).all(limit);
        queued.forEach(run => queuedHints.add(run.id));
        scheduleProcessQueue();
        return queued.length;
    }

    function getStatus() {
        const queued = db.prepare(`
            SELECT COUNT(*) AS count
            FROM agent_runs
            WHERE status = 'queued'
              AND deleted_at IS NULL
        `).get().count;
        const oldestQueued = db.prepare(`
            SELECT
                id,
                created_at,
                CAST((julianday(datetime('now', '+8 hours')) - julianday(created_at)) * 86400000 AS INTEGER) AS age_ms
            FROM agent_runs
            WHERE status = 'queued'
              AND deleted_at IS NULL
            ORDER BY priority DESC, created_at ASC
            LIMIT 1
        `).get() || null;
        const now = Date.now();
        const activeRuns = Array.from(activeRunIds).map(runId => ({
            runId,
            activeMs: Math.max(0, now - (activeStartedAt.get(runId) || now)),
            lockRenewing: lockRenewTimers.has(runId)
        }));
        return {
            instanceId,
            active: activeRunIds.size,
            activeRuns,
            queued,
            hinted: queuedHints.size,
            maxConcurrent: safeMaxConcurrent,
            maxConcurrentPerUser: safeMaxConcurrentPerUser,
            oldestQueuedRunId: oldestQueued?.id || null,
            oldestQueuedAgeMs: Math.max(0, Number(oldestQueued?.age_ms || 0))
        };
    }

    function updateMaxConcurrent(nextMaxConcurrent) {
        const next = Math.max(Number.parseInt(nextMaxConcurrent, 10) || safeMaxConcurrent, 1);
        if (next === safeMaxConcurrent) return safeMaxConcurrent;
        safeMaxConcurrent = next;
        scheduleProcessQueue();
        return safeMaxConcurrent;
    }

    return {
        enqueueRun,
        updateMaxConcurrent,
        processQueue,
        recoverQueued,
        getStatus
    };
}

module.exports = { createAgentQueue };
