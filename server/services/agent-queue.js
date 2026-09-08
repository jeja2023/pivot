const { query, queryOne, execute } = require('../db/client');
const { nowExpr } = require('../db/dialect');

const DEFAULT_LOCK_MS = 24 * 60 * 60 * 1000;
const USER_LOOKUP_RETRY_MS = 5000;
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
    getTimestamp,
    dbRunner: injectedDbRunner = null
}) {
    const dbRunner = injectedDbRunner || {
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
    let retryWakeTimer = null;
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

    function scheduleRetryWake(retryAfter) {
        if (!retryAfter) return;
        const normalized = String(retryAfter).includes('T') ? String(retryAfter) : `${retryAfter}+08:00`;
        const targetMs = Date.parse(normalized);
        if (!Number.isFinite(targetMs)) return;
        const delayMs = Math.max(0, Math.min(targetMs - Date.now(), 24 * 60 * 60 * 1000));
        if (retryWakeTimer) clearTimeout(retryWakeTimer);
        retryWakeTimer = setTimeout(() => {
            retryWakeTimer = null;
            scheduleProcessQueue();
        }, delayMs + 5);
        retryWakeTimer.unref?.();
    }

    async function claimNextRun() {
        const rows = await dbRunner.query(`
            SELECT id, user_id
            FROM agent_runs
            WHERE status = 'queued'
              AND deleted_at IS NULL
              AND (retry_after IS NULL OR retry_after <= ${currentTimeExpr})
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
                    retry_after = NULL,
                    started_at = COALESCE(started_at, ?),
                    last_heartbeat_at = ?,
                    updated_at = ?
                WHERE id = ?
                  AND status = 'queued'
                  AND deleted_at IS NULL
                  AND (retry_after IS NULL OR retry_after <= ${currentTimeExpr})
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

    async function requeueClaimedRunAfterUserLookupFailure(runId, error) {
        const retryAfter = getTimestamp(new Date(Date.now() + USER_LOOKUP_RETRY_MS));
        const changes = await dbRunner.execute(`
            UPDATE agent_runs
            SET status = 'queued',
                locked_by = NULL,
                lock_expires_at = NULL,
                retry_after = ?,
                updated_at = ?
            WHERE id = ? AND status = 'running' AND locked_by = ?
        `, [retryAfter, getTimestamp(), runId, instanceId]);
        if (changes === 1) {
            queuedHints.add(runId);
            scheduleRetryWake(retryAfter);
            logger.warn({ runId, instanceId, retryAfter, err: error?.message || String(error || '') }, '读取智能体任务所属用户失败，已释放认领并延迟重试');
        }
        return changes;
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
                let user;
                try {
                    user = await getRunUser(runId);
                } catch (error) {
                    // 认领已把状态切为 running；若此处直接抛出，任务会在没有执行者时
                    // 长时间卡住。用持锁 CAS 回到 queued，并设置短暂退避避免热循环。
                    await requeueClaimedRunAfterUserLookupFailure(runId, error);
                    break;
                }
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

    function enqueueRun(runId, options = {}) {
        if (runId) queuedHints.add(runId);
        if (options.retryAfter) scheduleRetryWake(options.retryAfter);
        scheduleProcessQueue();
    }

    async function recoverQueued(limit = 100, options = {}) {
        const queued = await dbRunner.query(`
            SELECT id, retry_after
            FROM agent_runs
            WHERE status = 'queued'
              AND deleted_at IS NULL
            ORDER BY priority DESC, created_at ASC
            LIMIT ?
        `, [limit]);
        queued.forEach(run => queuedHints.add(run.id));
        const nextRetry = await dbRunner.queryOne(`
            SELECT MIN(retry_after) AS retry_after
            FROM agent_runs
            WHERE status = 'queued'
              AND deleted_at IS NULL
              AND retry_after IS NOT NULL
              AND retry_after > ${currentTimeExpr}
        `);
        scheduleRetryWake(nextRetry?.retry_after);
        if (options.deferSchedule) setTimeout(scheduleProcessQueue, 0);
        else scheduleProcessQueue();
        return queued.length;
    }

    function queuedAgeMs(value) {
        const text = String(value || '').trim();
        const parsed = Date.parse(text.includes('T') ? text : `${text.replace(' ', 'T')}+08:00`);
        return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : 0;
    }

    function getStatus() {
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
            queued: queuedHints.size,
            hinted: queuedHints.size,
            maxConcurrent: safeMaxConcurrent,
            maxConcurrentPerUser: safeMaxConcurrentPerUser,
            oldestQueuedRunId: null,
            oldestQueuedAgeMs: 0
        };
    }

    async function getStatusAsync() {
        // 队列是 PostgreSQL 持久化状态，内存 hints 仅用于唤醒本进程；不能把
        // hints 当监控真相，否则其他节点认领/取消任务后指标会永久漂移。
        const queuedRows = await dbRunner.query(`
            SELECT id
            FROM agent_runs
            WHERE status = 'queued' AND deleted_at IS NULL
            ORDER BY priority DESC, created_at ASC
            LIMIT 5000
        `);
        const queuedSummary = await dbRunner.queryOne(`
            SELECT COUNT(*) AS count
            FROM agent_runs
            WHERE status = 'queued' AND deleted_at IS NULL
        `);
        const oldest = await dbRunner.queryOne(`
            SELECT id, created_at
            FROM agent_runs
            WHERE status = 'queued' AND deleted_at IS NULL
            ORDER BY created_at ASC, id ASC
            LIMIT 1
        `);
        queuedHints.clear();
        (queuedRows || []).forEach(row => queuedHints.add(row.id));
        const queuedCount = Number(queuedSummary?.count || 0);
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
            oldestQueuedRunId: oldest?.id || null,
            oldestQueuedAgeMs: queuedAgeMs(oldest?.created_at)
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
        getStatus,
        getStatusAsync,
        requeueClaimedRunAfterUserLookupFailure
    };
}

module.exports = { createAgentQueue };
