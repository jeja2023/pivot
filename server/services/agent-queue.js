const { query, queryOne, execute } = require('../db/client');
const { nowExpr } = require('../db/dialect');

const DEFAULT_LOCK_MS = 24 * 60 * 60 * 1000;
const ACTIVE_RUN_STATUSES = ['running', 'planning', 'executing', 'observing', 'diagnosing', 'replanning', 'resuming', 'approval_required'];

function createAgentQueue({
    logger = { info() {}, warn() {}, error() {} },
    instanceId,
    maxConcurrent,
    maxConcurrentPerUser = 2,
    lockMs = DEFAULT_LOCK_MS,
    getRunUser,
    runAgent,
    markRunError,
    getTimestamp
}) {
    const dbRunner = {
        query,
        execute,
        queryOne
    };

    const activeRunIds = new Set();
    const activeStartedAt = new Map();
    const lockRenewTimers = new Map();
    const queuedHints = new Set();
    const activeUserCounts = new Map();
    let processScheduled = false;
    let isProcessing = false;
    let safeMaxConcurrent = Number.isFinite(Number.parseInt(maxConcurrent, 10))
        ? Math.max(Number.parseInt(maxConcurrent, 10), 0)
        : 1;
    const safeMaxConcurrentPerUser = Math.max(Number.parseInt(maxConcurrentPerUser, 10) || 2, 1);
    const safeLockMs = Math.max(Number.parseInt(lockMs, 10) || DEFAULT_LOCK_MS, 60000);
    const lockRenewIntervalMs = Math.min(Math.max(Math.floor(safeLockMs / 3), 30000), 300000);
    const currentTimeExpr = nowExpr();

    const lockExpiresAt = () => getTimestamp(new Date(Date.now() + safeLockMs));

    function scheduleProcessQueue() {
        if (processScheduled) return;
        processScheduled = true;
        setImmediate(async () => {
            processScheduled = false;
            try {
                await processQueue();
            } catch (err) {
                logger.error({ err: err.message }, '智能体队列调度失败');
            }
        });
    }

    async function claimNextRun() {
        const rows = await dbRunner.query(`
            SELECT id, user_id
            FROM agent_runs
            WHERE status = 'queued'
              AND deleted_at IS NULL
              AND (
                  locked_by IS NULL
                  OR lock_expires_at IS NULL
                  OR lock_expires_at <= ${currentTimeExpr}
              )
            ORDER BY priority DESC, created_at ASC
            LIMIT 50
        `);

        for (const row of rows) {
            if ((activeUserCounts.get(row.user_id) || 0) >= safeMaxConcurrentPerUser) continue;
            const now = getTimestamp();
            const changes = await dbRunner.execute(`
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
                      OR lock_expires_at <= ${currentTimeExpr}
                  )
            `, [instanceId, lockExpiresAt(), now, now, now, row.id]);

            if (changes === 1) return row;
        }

        return null;
    }

    async function renewRunLock(runId) {
        const now = getTimestamp();
        const changes = await dbRunner.execute(`
            UPDATE agent_runs
            SET lock_expires_at = ?,
                last_heartbeat_at = ?,
                updated_at = ?
            WHERE id = ?
              AND locked_by = ?
              AND status IN (${ACTIVE_RUN_STATUSES.map(() => '?').join(', ')})
              AND deleted_at IS NULL
        `, [lockExpiresAt(), now, now, runId, instanceId, ...ACTIVE_RUN_STATUSES]);
        if (changes === 0) {
            logger.warn({ runId, instanceId }, '跳过智能体运行锁续期：持锁者或状态已变更');
        }
        return changes;
    }

    function stopLockRenewal(runId) {
        const timer = lockRenewTimers.get(runId);
        if (timer) clearInterval(timer);
        lockRenewTimers.delete(runId);
    }

    function startLockRenewal(runId) {
        stopLockRenewal(runId);
        const timer = setInterval(async () => {
            try {
                await renewRunLock(runId);
            } catch (err) {
                logger.warn({ err: err.message, runId }, '智能体运行锁续期失败');
            }
        }, lockRenewIntervalMs);
        timer.unref?.();
        lockRenewTimers.set(runId, timer);
    }

    async function releaseRun(runId) {
        await dbRunner.execute(`
            UPDATE agent_runs
            SET locked_by = NULL,
                lock_expires_at = NULL
            WHERE id = ? AND locked_by = ?
        `, [runId, instanceId]);
    }

    async function processQueue() {
        if (isProcessing || safeMaxConcurrent <= 0) return;
        isProcessing = true;
        try {
            while (activeRunIds.size < safeMaxConcurrent) {
                const claimed = await claimNextRun();
                if (!claimed || activeRunIds.has(claimed.id)) break;
                if (safeMaxConcurrent <= 0 || activeRunIds.size >= safeMaxConcurrent) {
                    await dbRunner.execute(`
                        UPDATE agent_runs
                        SET status = 'queued',
                            locked_by = NULL,
                            lock_expires_at = NULL
                        WHERE id = ? AND locked_by = ?
                    `, [claimed.id, instanceId]);
                    break;
                }
                const runId = claimed.id;
                const user = await getRunUser(runId);
                if (!user) {
                    const row = await dbRunner.queryOne('SELECT status FROM agent_runs WHERE id = ?', [runId]);
                    if (!['cancelled', 'deleted', 'error', 'completed', 'completed_with_errors'].includes(row?.status)) {
                        await markRunError(runId, 'Agent run user no longer exists.');
                    }
                    await releaseRun(runId);
                    continue;
                }

                activeRunIds.add(runId);
                activeUserCounts.set(user.id, (activeUserCounts.get(user.id) || 0) + 1);
                activeStartedAt.set(runId, Date.now());
                startLockRenewal(runId);
                queuedHints.delete(runId);
                runAgent(runId, user).catch(async err => {
                    logger.error({ err: err.message, runId }, '智能体运行在运行时锁保护下发生异常');
                    await markRunError(runId, err.message);
                }).finally(async () => {
                    activeRunIds.delete(runId);
                    const nextUserCount = Math.max((activeUserCounts.get(user.id) || 1) - 1, 0);
                    if (nextUserCount === 0) activeUserCounts.delete(user.id);
                    else activeUserCounts.set(user.id, nextUserCount);
                    activeStartedAt.delete(runId);
                    stopLockRenewal(runId);
                    await releaseRun(runId);
                    scheduleProcessQueue();
                });
            }
        } finally {
            isProcessing = false;
        }
    }

    function enqueueRun(runId) {
        if (runId) queuedHints.add(runId);
        scheduleProcessQueue();
    }

    async function recoverQueued(limit = 100, options = {}) {
        const queued = await dbRunner.query(`
            SELECT id
            FROM agent_runs
            WHERE status = 'queued'
              AND deleted_at IS NULL
            ORDER BY priority DESC, created_at ASC
            LIMIT ?
        `, [limit]);
        queued.forEach(run => queuedHints.add(run.id));
        if (options.deferSchedule) setTimeout(scheduleProcessQueue, 0);
        else scheduleProcessQueue();
        return queued.length;
    }

    function getStatus() {
        const queuedCount = queuedHints.size;
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
            queued: queuedCount,
            hinted: queuedHints.size,
            maxConcurrent: safeMaxConcurrent,
            maxConcurrentPerUser: safeMaxConcurrentPerUser,
            oldestQueuedRunId: null,
            oldestQueuedAgeMs: 0
        };
    }

    function updateMaxConcurrent(nextMaxConcurrent) {
        const parsed = Number.parseInt(nextMaxConcurrent, 10);
        const next = Number.isFinite(parsed) ? Math.max(parsed, 0) : safeMaxConcurrent;
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
