'use strict';

const { query } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');
const { evaluateBreaker } = require('./agent-skill-rollout');
const { pauseWorkflowReleaseBySystem, rollbackWorkflowReleaseBySystem } = require('./agent-releases');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

function parseJson(value) { try { return value && typeof value === 'object' ? value : JSON.parse(String(value || '{}')); } catch (_) { return {}; } }

async function collectWorkflowReleaseMetrics(releaseId, since, read = query) {
    const toolRows = await read(`
        SELECT COUNT(*) AS samples,
            COALESCE(SUM(CASE WHEN c.policy_decision = 'denied' THEN 1 ELSE 0 END), 0) AS policy_denied,
            COALESCE(SUM(CASE WHEN c.status <> 'success' THEN 1 ELSE 0 END), 0) AS tool_errors,
            COALESCE(SUM(CASE WHEN c.error_category = 'timeout' THEN 1 ELSE 0 END), 0) AS timeouts
        FROM agent_tool_calls c JOIN agent_runs r ON r.id = c.run_id
        WHERE r.metadata->>'workflowReleaseId' = ? AND c.created_at >= ?
    `, [String(releaseId), since]);
    const feedbackRows = await read(`
        SELECT COALESCE(SUM(CASE WHEN f.outcome = 'rejected' OR COALESCE(f.rating, 3) <= 2 THEN 1 ELSE 0 END), 0) AS negative_feedback
        FROM agent_feedback f JOIN agent_runs r ON r.id = f.run_id
        WHERE r.metadata->>'workflowReleaseId' = ? AND f.created_at >= ?
    `, [String(releaseId), since]);
    const row = toolRows?.[0] || {};
    return { samples: Number(row.samples || 0), policyDenied: Number(row.policy_denied || 0), toolErrors: Number(row.tool_errors || 0), timeouts: Number(row.timeouts || 0), negativeFeedback: Number(feedbackRows?.[0]?.negative_feedback || 0) };
}

async function sweepWorkflowReleaseBreakers({ windowMinutes = 30, read = query, pause = pauseWorkflowReleaseBySystem, rollback = rollbackWorkflowReleaseBySystem } = {}) {
    const since = getBeijingTimestamp(new Date(Date.now() - Math.max(1, Math.min(Number(windowMinutes) || 30, 1440)) * 60 * 1000));
    const releases = await read(`
        SELECT r.*, w.user_id AS workflow_owner_id FROM agent_workflow_releases r
        JOIN agent_workflows w ON w.id = r.workflow_id
        WHERE r.status = 'published' ORDER BY r.published_at DESC LIMIT 200
    `);
    const actions = [];
    for (const release of releases || []) {
        const thresholds = parseJson(release.breaker_thresholds);
        if (!Object.keys(thresholds).length) continue;
        const metrics = await collectWorkflowReleaseMetrics(release.id, since, read);
        const decision = evaluateBreaker(thresholds, metrics);
        if (!decision.tripped) continue;
        const reason = `${decision.reason} 触发工作流灰度熔断（样本 ${decision.samples}）。`;
        const action = release.previous_release_id ? await rollback(release, reason) : await pause(release, reason);
        if (action?.action && action.action !== 'skipped') actions.push({ releaseId: release.id, action: action.action, reason });
    }
    return { evaluated: (releases || []).length, tripped: actions.length, actions };
}

function createWorkflowReleaseBreakerRunner(options = {}) {
    const intervalMs = Math.max(60_000, Number.parseInt(options.intervalMs, 10) || DEFAULT_INTERVAL_MS);
    let timer = null;
    const tick = async () => { try { return await sweepWorkflowReleaseBreakers(options); } catch (error) { logger.warn({ err: error.message }, '工作流发布熔断巡检失败'); return null; } };
    let inFlight = null;
    const trackedTick = () => {
        if (inFlight) return inFlight;
        inFlight = Promise.resolve().then(tick).finally(() => { inFlight = null; });
        return inFlight;
    };
    return { start() { if (!timer) { timer = setInterval(() => { void trackedTick(); }, intervalMs); timer.unref?.(); void trackedTick(); } return timer; }, async stop() { if (timer) clearInterval(timer); timer = null; if (inFlight) await inFlight; }, tick: trackedTick, intervalMs };
}

module.exports = { createWorkflowReleaseBreakerRunner, sweepWorkflowReleaseBreakers };
