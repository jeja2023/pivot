'use strict';

function createRunFinalizer({ activeRunControllers, updateRun, getBeijingTimestamp, syncAgentTraceFromRun }) {
    async function finalize({ runId, runController, deadlineTimer, taskBudget, lostExecutionLease }) {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (activeRunControllers.get(runId) === runController) activeRunControllers.delete(runId);
        if (taskBudget && !lostExecutionLease) {
            try { await updateRun(runId, { usage_stats: JSON.stringify(taskBudget.snapshot()), updated_at: getBeijingTimestamp() }); } catch (_) {}
        }
        if (!lostExecutionLease) await syncAgentTraceFromRun(runId);
    }
    return { finalize };
}

module.exports = { createRunFinalizer };
