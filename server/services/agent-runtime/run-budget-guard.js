'use strict';

function createRunBudgetGuard({ deadline, taskBudget }) {
    return () => {
        if (Date.now() > deadline) {
            const err = new Error('任务执行超时。');
            err.code = 'AGENT_TIMEOUT';
            throw err;
        }
        taskBudget.assertCanRequestModel();
    };
}

function createRemainingModelRequestMs({ deadline, resolveAgentRequestTimeoutMs }) {
    return () => Math.min(resolveAgentRequestTimeoutMs(), Math.max(deadline - Date.now(), 1_000));
}

function createRunDeadlineTimer({ deadline, runController }) {
    const timer = setTimeout(() => {
        const error = new Error('智能体运行超时。');
        error.code = 'AGENT_TIMEOUT';
        runController.abort(error);
    }, Math.max(deadline - Date.now(), 1));
    timer.unref?.();
    return timer;
}

module.exports = { createRunBudgetGuard, createRemainingModelRequestMs, createRunDeadlineTimer };

