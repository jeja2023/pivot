const RUN_STATUSES = new Set([
    'queued',
    'planning',
    'executing',
    'observing',
    'diagnosing',
    'replanning',
    'running',
    'approval_required',
    'awaiting_approval',
    'waiting_approval',
    'resuming',
    'completed',
    'completed_with_errors',
    'error',
    'failed',
    'cancelled',
    'deleted'
]);

const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'error', 'failed', 'cancelled', 'deleted']);

const TRANSITIONS = {
    queued: new Set(['planning', 'running', 'cancelled', 'error', 'failed', 'deleted']),
    planning: new Set(['queued', 'executing', 'running', 'observing', 'waiting_approval', 'approval_required', 'completed', 'completed_with_errors', 'cancelled', 'error', 'failed', 'deleted']),
    executing: new Set(['queued', 'observing', 'diagnosing', 'planning', 'approval_required', 'waiting_approval', 'running', 'completed', 'completed_with_errors', 'cancelled', 'error', 'failed', 'deleted']),
    observing: new Set(['queued', 'diagnosing', 'replanning', 'planning', 'waiting_approval', 'approval_required', 'completed', 'completed_with_errors', 'running', 'cancelled', 'error', 'failed', 'deleted']),
    diagnosing: new Set(['queued', 'replanning', 'planning', 'waiting_approval', 'approval_required', 'completed_with_errors', 'completed', 'error', 'failed', 'cancelled', 'deleted']),
    replanning: new Set(['queued', 'planning', 'executing', 'running', 'waiting_approval', 'approval_required', 'completed', 'completed_with_errors', 'cancelled', 'error', 'failed', 'deleted']),
    running: new Set(['planning', 'executing', 'observing', 'diagnosing', 'replanning', 'approval_required', 'awaiting_approval', 'waiting_approval', 'completed', 'completed_with_errors', 'error', 'failed', 'cancelled', 'queued', 'deleted']),
    approval_required: new Set(['queued', 'resuming', 'cancelled', 'error', 'deleted']),
    awaiting_approval: new Set(['queued', 'resuming', 'running', 'cancelled', 'error', 'deleted']),
    waiting_approval: new Set(['queued', 'resuming', 'cancelled', 'error', 'deleted']),
    resuming: new Set(['queued', 'planning', 'executing', 'running', 'waiting_approval', 'approval_required', 'cancelled', 'error', 'failed', 'deleted']),
    completed: new Set(['deleted']),
    completed_with_errors: new Set(['deleted']),
    error: new Set(['queued', 'deleted']),
    failed: new Set(['queued', 'deleted']),
    cancelled: new Set(['queued', 'deleted']),
    deleted: new Set([])
};

function normalizeRunStatus(status) {
    const value = String(status || '').trim();
    return RUN_STATUSES.has(value) ? value : '';
}

function canTransitionAgentRunStatus(fromStatus, toStatus) {
    const from = normalizeRunStatus(fromStatus);
    const to = normalizeRunStatus(toStatus);
    if (!to) return false;
    if (!from || from === to) return true;
    if (to === 'deleted') return true;
    return TRANSITIONS[from]?.has(to) === true;
}

function transitionAgentRunStatus(fromStatus, toStatus, details = {}) {
    const from = normalizeRunStatus(fromStatus);
    const to = normalizeRunStatus(toStatus);
    const allowed = canTransitionAgentRunStatus(from, to);
    return {
        from,
        to,
        allowed,
        terminal: TERMINAL_STATUSES.has(to),
        reason: details.reason || ''
    };
}

function assertAgentRunStatusTransition(fromStatus, toStatus, details = {}) {
    const transition = transitionAgentRunStatus(fromStatus, toStatus, details);
    if (!transition.allowed) {
        const err = new Error(`任务状态变更无效：${transition.from || '<new>'} -> ${transition.to || '<invalid>'}`);
        err.code = 'AGENT_INVALID_STATUS_TRANSITION';
        err.transition = transition;
        throw err;
    }
    return transition;
}

module.exports = {
    RUN_STATUSES,
    TERMINAL_STATUSES,
    TRANSITIONS,
    normalizeRunStatus,
    canTransitionAgentRunStatus,
    transitionAgentRunStatus,
    assertAgentRunStatusTransition
};
