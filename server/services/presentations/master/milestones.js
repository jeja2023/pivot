'use strict';

function markMilestone(state, key) {
    state.milestones ||= {};
    if (state.milestones[key]) return;
    const startedAt = Number(state.startedAt || Date.now());
    state.milestones[key] = { steps: Number(state.steps || 0), usedTokens: Number(state.usedTokens || 0), elapsedMs: Math.max(0, Date.now() - startedAt) };
}

module.exports = { markMilestone };
