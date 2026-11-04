'use strict';

const { ACTIVE_STATUSES, normalizeMaxSteps, parseJsonObject } = require('./agent-validators');
const { runRoundPolicy } = require('./agent-round-policy');

function buildRunProgress(run = {}, steps = []) {
    const maxSteps = normalizeMaxSteps(run.max_steps, run.run_mode), policy = runRoundPolicy(run);
    const usage = parseJsonObject(run.usage_stats) || {}, metadata = parseJsonObject(run.metadata) || {};
    const planCount = steps.filter(step => step.type === 'plan').length;
    const toolCount = Math.max(Number(usage.counts?.tool_calls) || 0, steps.filter(step => step.type === 'tool').length);
    const isDag = run.run_mode === 'dag';
    const roundCount = isDag ? 0 : Math.max(Number(usage.counts?.steps) || 0, planCount);
    const segmentStart = Math.max(0, Number(usage.segment?.startSteps) || 0);
    const segmentRoundCount = Math.max(0, roundCount - segmentStart);
    const active = ACTIVE_STATUSES.has(run.status), count = isDag ? toolCount : roundCount;
    return { maxSteps, planCount, roundCount, totalRoundCount: roundCount, totalRoundLimit: policy.totalSteps,
        segmentRoundCount, segmentRoundLimit: maxSteps, segmentNumber: Math.max(0, Number(metadata.autoContinuation?.count) || 0) + 1,
        toolCount, errorCount: steps.filter(step => step.status === 'error').length, stepCount: steps.length,
        totalDurationMs: steps.reduce((sum, step) => sum + (Number(step.duration_ms) || 0), 0),
        stopReason: metadata.budgetStop?.code || metadata.continuationStop?.code || usage.tripped?.key || null,
        isLimitReached: !isDag && roundCount >= policy.totalSteps,
        segmentLimitReached: !isDag && segmentRoundCount >= maxSteps,
        percent: active ? Math.min(Math.round(count / Math.max(1, policy.totalSteps) * 100), 95)
            : ['completed', 'completed_with_errors', 'partial', 'needs_input'].includes(run.status) ? 100 : 0 };
}

module.exports = { buildRunProgress };
