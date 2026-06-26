const DEFAULT_LOCK_MS = 24 * 60 * 60 * 1000;

function createAgentQueue({
    db,
    logger,
    instanceId,
    maxConcurrent,
    lockMs = DEFAULT_LOCK_MS,
    getRunUser,
    runAgent,
    markRunError,
    getTimestamp
}) {
    const activeRunIds = new Set();
    const queuedHints = new Set();
    let processScheduled = false;
    let safeMaxConcurrent = Math.max(Number.parseInt(maxConcurrent, 10) || 1, 1);
    const safeLockMs = Math.max(Number.parseInt(lockMs, 10) || DEFAULT_LOCK_MS, 60000);

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
            SELECT id
            FROM agent_runs
            WHERE status = 'queued'
              AND deleted_at IS NULL
              AND (
                  locked_by IS NULL
                  OR lock_expires_at IS NULL
                  OR lock_expires_at <= datetime('now', '+8 hours')
              )
            ORDER BY priority DESC, created_at ASC
            LIMIT 10
        `).all();

        for (const row of rows) {
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

            if (result.changes === 1) return row.id;
        }

        return null;
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
            const runId = claimNextRun();
            if (!runId || activeRunIds.has(runId)) break;
            const user = getRunUser(runId);
            if (!user) {
                markRunError(runId, 'Agent run user no longer exists.');
                releaseRun(runId);
                continue;
            }

            activeRunIds.add(runId);
            queuedHints.delete(runId);
            runAgent(runId, user).catch(err => {
                logger.error({ err: err.message, runId }, '鏅鸿兘浣撹繍琛屽湪杩愯鏃朵繚鎶ゅ澶辫触');
                markRunError(runId, err.message);
            }).finally(() => {
                activeRunIds.delete(runId);
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
        return {
            instanceId,
            active: activeRunIds.size,
            queued,
            hinted: queuedHints.size,
            maxConcurrent: safeMaxConcurrent
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
