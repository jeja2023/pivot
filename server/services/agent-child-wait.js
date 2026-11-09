'use strict';

const { getBeijingTimestamp } = require('../time');
const ACTIVE = ['running', 'planning', 'executing', 'observing', 'resuming'];
const USER_BOUNDARIES = new Set(['needs_input', 'approval_required', 'awaiting_approval', 'waiting_approval', 'awaiting_commit']);

function metadata(run) { return typeof run.metadata === 'string' ? JSON.parse(run.metadata) : run.metadata || {}; }
function deadlineFor(run, budget, now) {
    const raw = run.started_at;
    const start = raw instanceof Date ? raw.getTime() : raw ? Date.parse(String(raw).includes('T') ? String(raw) : String(raw).replace(' ', 'T') + '+08:00') : now - Number(budget?.elapsedSeconds?.() || 0) * 1000;
    const usage = typeof run.usage_stats === 'string' ? JSON.parse(run.usage_stats) : run.usage_stats;
    const runtimeSeconds = budget?.limits?.max_runtime_seconds ?? usage?.limits?.max_runtime_seconds;
    const runtimeMs = runtimeSeconds == null ? Infinity : Math.max(0, Number(runtimeSeconds) * 1000);
    return (Number.isFinite(start) ? start : now) + Math.min(Math.max(1000, Number(run.timeout_ms) || 600000), runtimeMs);
}

async function clearWaiting(run, deps) {
    const changed = await deps.updateRunCas(run.id, ACTIVE, { metadata: JSON.stringify({ awaitingChildren: null }) }, {
        mergeMetadata: true, leaseBinding: run.realtimeLeaseOwner ? { owner: run.realtimeLeaseOwner, epoch: run.realtimeLeaseEpoch } : null
    });
    if (changed) run.metadata = { ...metadata(run), awaitingChildren: null };
    return Boolean(changed);
}

async function deferChildWait({ run, user, children, budget }, deps) {
    const ids = [...new Set(children.map(child => String(child.id || '')).filter(Boolean))].slice(0, 32);
    if (!ids.length || children.some(child => USER_BOUNDARIES.has(child.status))) return false;
    const now = deps.now?.() ?? Date.now();
    if (now >= deadlineFor(run, budget, now)) throw Object.assign(new Error('等待子任务已达到原任务时间上限。'), { code: 'AGENT_TIMEOUT', category: 'resource' });
    await deps.assertRunNotCancelled?.(run.id);
    await budget?.persistUsageSnapshot?.();
    const retryAfter = getBeijingTimestamp(new Date(now + 3000));
    const waiting = { childRunIds: ids };
    const changed = await deps.updateRunCas(run.id, ACTIVE, { status: 'queued', retry_after: retryAfter,
        metadata: JSON.stringify({ awaitingChildren: waiting }), updated_at: getBeijingTimestamp(new Date(now)) }, {
        mergeMetadata: true, leaseBinding: run.realtimeLeaseOwner ? { owner: run.realtimeLeaseOwner, epoch: run.realtimeLeaseEpoch } : null
    });
    if (budget) budget.requeued = true;
    if (!changed) return true;
    run.metadata = { ...metadata(run), awaitingChildren: waiting };
    deps.enqueueAgentRun(run.id, user, { retryAfter });
    return true;
}

async function deferAfterChildTool({ run, user, toolName, output, budget }, deps) {
    if (!['agent.wait', 'agent.join'].includes(toolName) || !['agent_wait', 'agent_join'].includes(output?.type)
        || output.complete !== false || output.parentRunId !== run.id) return false;
    return deferChildWait({ run, user, budget, children: output.children || output.results || [] }, deps);
}

async function waitBeforePlanning({ run, user }, deps) {
    const waiting = metadata(run).awaitingChildren;
    if (!Array.isArray(waiting?.childRunIds) || !waiting.childRunIds.length) return false;
    const messages = await (deps.listControlMessages || require('./agent-control').listAgentControlMessages)(run.id, user, { status: 'pending', limit: 20 });
    if ((messages || []).some(message => message.toRunId === run.id)) return !await clearWaiting(run, deps);
    const result = await (deps.wait || require('./agent-tools-collaboration').executeAgentWait)({ childRunIds: waiting.childRunIds }, user, { run });
    if (result.complete || result.children.some(child => USER_BOUNDARIES.has(child.status))) return !await clearWaiting(run, deps);
    return deferChildWait({ run, user, children: result.children }, deps);
}

module.exports = { deferAfterChildTool, waitBeforePlanning };
