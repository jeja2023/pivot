'use strict';

async function finishVerifyingRunAfterLeaseLoss({ execute, runId, instanceId, message, now, epoch }) {
    return execute(`UPDATE agent_runs SET status = 'error', completed_at = ?, updated_at = ?,
        error_message = ?, locked_by = NULL, lock_expires_at = NULL
        WHERE id = ? AND locked_by = ? AND status = 'verifying'
        ${epoch ? 'AND realtime_lease_epoch = ?' : ''}`,
    [now, now, message, runId, instanceId, ...(epoch ? [String(epoch)] : [])]);
}

module.exports = { finishVerifyingRunAfterLeaseLoss };
