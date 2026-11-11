const { EXECUTION_LEASE_STATUSES } = require('./state-machine');
const { finishVerifyingRunAfterLeaseLoss } = require('../../repositories/agent-run-leases');

/** 核验中丢失执行权保留结果并明确失败，其余可恢复阶段安全回队。 */
async function requeueAgentRunAfterLeaseLoss({ execute, getTimestamp, enqueueAgentRun, finalizeTerminalRun, instanceId, runId, epoch, error } = {}) {
    const message = String(error?.message || '执行租约已失效，结果尚未完成核验，请检查后重试。').slice(0, 2000);
    const ended = await finishVerifyingRunAfterLeaseLoss({ execute, runId, instanceId, message, epoch, now: getTimestamp() });
    if (ended === 1) {
        await finalizeTerminalRun?.(runId, 'error');
        return ended;
    }
    const retryAfter = getTimestamp(new Date(Date.now() + 5000));
    const changes = await execute(`
        UPDATE agent_runs
        SET status = 'queued', locked_by = NULL, lock_expires_at = NULL,
            retry_after = ?, error_message = ?, updated_at = ?
        WHERE id = ? AND locked_by = ?
          AND status IN (${EXECUTION_LEASE_STATUSES.filter(status => status !== 'verifying').map(() => '?').join(', ')})
          ${epoch ? 'AND realtime_lease_epoch = ?' : ''}
    `, [retryAfter, message, getTimestamp(), runId, instanceId, ...EXECUTION_LEASE_STATUSES.filter(status => status !== 'verifying'), ...(epoch ? [String(epoch)] : [])]);
    if (changes === 1) enqueueAgentRun(runId, null, { retryAfter });
    return changes;
}

module.exports = { requeueAgentRunAfterLeaseLoss };
