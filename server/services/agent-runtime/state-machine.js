const RUN_STATUSES = new Set([
    'queued',
    'running',
    'approval_required',
    'completed',
    'completed_with_errors',
    'error',
    'cancelled',
    'deleted'
]);

const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'error', 'cancelled', 'deleted']);

const TRANSITIONS = {
    queued: new Set(['running', 'cancelled', 'error', 'deleted']),
    running: new Set(['approval_required', 'completed', 'completed_with_errors', 'error', 'cancelled', 'queued', 'deleted']),
    approval_required: new Set(['queued', 'cancelled', 'error', 'deleted']),
    completed: new Set(['deleted']),
    completed_with_errors: new Set(['deleted']),
    error: new Set(['queued', 'deleted']),
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
        const err = new Error(`Invalid agent run status transition: ${transition.from || '<new>'} -> ${transition.to || '<invalid>'}`);
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
