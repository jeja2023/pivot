/** 将仍由本实例持锁、但已失去执行租约的任务安全回队。 */
async function requeueAgentRunAfterLeaseLoss({ execute, getTimestamp, enqueueAgentRun, instanceId, runId, error } = {}) {
    const retryAfter = getTimestamp(new Date(Date.now() + 5000));
    const changes = await execute(`
        UPDATE agent_runs
        SET status = 'queued', locked_by = NULL, lock_expires_at = NULL,
            retry_after = ?, error_message = ?, updated_at = ?
        WHERE id = ? AND locked_by = ?
          AND status IN ('running', 'planning', 'executing', 'observing', 'diagnosing', 'replanning', 'resuming')
    `, [retryAfter, String(error?.message || '执行租约已失效。').slice(0, 2000), getTimestamp(), runId, instanceId]);
    if (changes === 1) enqueueAgentRun(runId, null, { retryAfter });
    return changes;
}

module.exports = { requeueAgentRunAfterLeaseLoss };
