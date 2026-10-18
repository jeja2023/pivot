const { query, queryOne } = require('../db/client');
const { nowOffsetExpr } = require('../db/dialect');
const { normalizePositiveInt } = require('./agent-validators');
const { isSuperAdmin } = require('../permissions');
const { getPrimaryTenantId } = require('./enterprise-access');
const { createAgentInboxEvent } = require('./agent-inbox');

const AGENT_RUNTIME_SLO = Object.freeze({ minSamples: 30, successRate: 0.95, failureRate: 0.05, p95DurationMs: 300000 });

function assessAgentRuntimeSlo(summary = {}) {
    const total = Math.max(0, Number(summary.terminalCount ?? summary.total ?? 0));
    const completed = Math.max(0, Number(summary.completed || 0));
    const failures = Math.max(0, Number(summary.error || 0) + Number(summary.failed || 0) + Number(summary.partial || 0) + Number(summary.completedWithErrors || 0));
    const successRate = total ? completed / total : null;
    const failureRate = total ? failures / total : null;
    const p95DurationMs = Math.max(0, Number(summary.p95DurationMs || 0));
    const blockers = [];
    if (total < AGENT_RUNTIME_SLO.minSamples) blockers.push('sample_insufficient');
    if (successRate !== null && successRate < AGENT_RUNTIME_SLO.successRate) blockers.push('success_rate_low');
    if (failureRate !== null && failureRate > AGENT_RUNTIME_SLO.failureRate) blockers.push('failure_rate_high');
    if (p95DurationMs > AGENT_RUNTIME_SLO.p95DurationMs) blockers.push('p95_duration_high');
    return { total, completed, failures, successRate, failureRate, p95DurationMs, thresholds: AGENT_RUNTIME_SLO, status: blockers.length ? (blockers.includes('sample_insufficient') ? 'insufficient_data' : 'attention') : 'passing', blockers };
}

async function getAgentRuntimeStatus(options = {}) {
    const user = options.user || null;
    const queueStatus = options.queueStatus || {};
    const maxConcurrent = normalizePositiveInt(options.maxConcurrent, 1, 1, 1000);
    const totalRow = await queryOne(`
        SELECT COUNT(*) AS count FROM agent_runs
        WHERE status = 'queued' AND deleted_at IS NULL
    `);
    const queuedTotal = Number(totalRow?.count || 0);
    let userQueued = 0;
    if (user?.id) {
        const userRow = await queryOne(`
            SELECT COUNT(*) AS count FROM agent_runs
            WHERE status = 'queued' AND deleted_at IS NULL AND user_id = ?
        `, [user.id]);
        userQueued = Number(userRow?.count || 0);
    }
    return {
        maxConcurrent,
        instanceId: queueStatus.instanceId || '',
        active: Number(queueStatus.active || 0),
        queued: Number(queueStatus.queued || 0),
        hinted: Number(queueStatus.hinted || 0),
        databaseQueued: queuedTotal,
        userQueued
    };
}

async function getAgentMetrics(user, days = 7) {
    const safeDays = normalizePositiveInt(days, 7, 1, 90);
    const superAdmin = isSuperAdmin(user);
    const tenantId = user?.tenant_id || await getPrimaryTenantId(user?.id);
    const timeFilter = nowOffsetExpr(`-${safeDays} days`);
    const baseWhere = superAdmin
        ? `created_at >= ${timeFilter}`
        : `user_id = ? AND (tenant_id IS NULL OR tenant_id = ?) AND created_at >= ${timeFilter}`;
    const actualParams = superAdmin ? [] : [user.id, tenantId];
    const summary = await queryOne(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'completed_with_errors' THEN 1 ELSE 0 END) AS completedWithErrors,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
            SUM(CASE WHEN status IN ('completed','completed_with_errors','error','failed','partial') THEN 1 ELSE 0 END) AS terminal_count,
            SUM(CASE WHEN status IN ('queued','running','approval_required','awaiting_approval','awaiting_commit') THEN 1 ELSE 0 END) AS active,
            COALESCE(SUM(total_tokens), 0) AS totalTokens
        FROM agent_runs
        WHERE deleted_at IS NULL AND ${baseWhere}
    `, actualParams);
    const toolStats = await query(`
        SELECT s.tool_name, COUNT(*) AS count
        FROM agent_steps s
        JOIN agent_runs r ON r.id = s.run_id
        WHERE r.deleted_at IS NULL AND s.type = 'tool' AND ${baseWhere.replace(/created_at/g, 'r.created_at')}
        GROUP BY s.tool_name
        ORDER BY count DESC
        LIMIT 10
    `, actualParams);
    const durationRow = await queryOne(`
        SELECT COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (COALESCE(completed_at, updated_at) - created_at)) * 1000
        ), 0) AS p95_duration_ms
        FROM agent_runs
        WHERE deleted_at IS NULL
          AND status IN ('completed', 'completed_with_errors', 'error', 'failed', 'cancelled', 'partial')
          AND ${baseWhere}
    `, actualParams);
    const contextCompaction = await getAgentContextCompactionMetrics(user, safeDays);
    const runtimeSlo = assessAgentRuntimeSlo({
        total: Number(summary?.total || 0), completed: Number(summary?.completed || 0),
        terminalCount: Number(summary?.terminal_count || 0), completedWithErrors: Number(summary?.completedWithErrors || 0),
        error: Number(summary?.error || 0), failed: Number(summary?.failed || 0), partial: Number(summary?.partial || 0),
        p95DurationMs: Number(durationRow?.p95_duration_ms || 0)
    });
    return {
        days: safeDays,
        total: Number(summary?.total || 0),
        completed: Number(summary?.completed || 0),
        completedWithErrors: Number(summary?.completedWithErrors || 0),
        error: Number(summary?.error || 0),
        cancelled: Number(summary?.cancelled || 0),
        active: Number(summary?.active || 0),
        successRate: Number(summary?.total || 0) ? Math.round((Number(summary?.completed || 0) / Number(summary?.total || 0)) * 100) : 0,
        totalTokens: Number(summary?.totalTokens || 0),
        toolStats: toolStats || [],
        runtimeSlo,
        contextCompaction
    };
}

async function runAgentRuntimeSloMonitor(options = {}) {
    const listAdmins = options.listAdmins || (async () => await query(`
        SELECT id, username, role FROM users
        WHERE role IN ('admin', 'root') AND COALESCE(status, 'active') != 'disabled' AND deleted_at IS NULL
    `));
    const getMetrics = options.getMetrics || getAgentMetrics;
    const createInboxEvent = options.createInboxEvent || createAgentInboxEvent;
    const admins = await listAdmins();
    let alerts = 0;
    for (const admin of admins || []) {
        if (!isSuperAdmin(admin)) continue;
        const metrics = await getMetrics(admin, options.days || 7);
        const slo = metrics?.runtimeSlo || {};
        if (slo.status !== 'attention') continue;
        const blockers = Array.isArray(slo.blockers) ? slo.blockers.slice(0, 8) : [];
        const key = `runtime.slo:${Number(metrics?.days || 7)}:${blockers.join(',') || 'attention'}`;
        await createInboxEvent(admin, {
            eventKey: key,
            eventType: 'runtime.slo_attention',
            sourceId: 'agent_runtime',
            title: 'Agent 运行 SLO 需要关注',
            body: `最近 ${Number(metrics?.days || 7)} 天 ${Number(slo.total || 0)} 个可评估任务，p95 时延 ${Math.round(Number(slo.p95DurationMs || 0) / 1000)} 秒；阻断项：${blockers.join('、') || '未分类'}。`,
            risk: 'high',
            payload: { days: Number(metrics?.days || 7), total: Number(slo.total || 0), blockers, p95DurationMs: Number(slo.p95DurationMs || 0) }
        });
        alerts += 1;
    }
    return { alerts };
}

/**
 * 聚合的是压缩审计中的数值字段，而不是上下文正文。这样质量面板可以观察
 * 节省与硬字段丢失，而不会扩大任务内容的可见范围。
 */
async function getAgentContextCompactionMetrics(user, days = 7, deps = {}) {
    const runQueryOne = deps.queryOne || queryOne;
    const safeDays = normalizePositiveInt(days, 7, 1, 90);
    const superAdmin = isSuperAdmin(user);
    const tenantId = user?.tenant_id || await getPrimaryTenantId(user?.id);
    const timeFilter = nowOffsetExpr(`-${safeDays} days`);
    const baseWhere = superAdmin
        ? `e.created_at >= ${timeFilter}`
        : `e.user_id = ? AND (r.tenant_id IS NULL OR r.tenant_id = ?) AND e.created_at >= ${timeFilter}`;
    const params = superAdmin ? [] : [user.id, tenantId];
    const summary = await runQueryOne(`
        SELECT
            COUNT(*) AS event_count,
            COUNT(DISTINCT e.run_id) AS run_count,
            COALESCE(SUM((e.payload #>> '{compaction,inputTokensBefore}')::bigint), 0) AS input_tokens_before,
            COALESCE(SUM((e.payload #>> '{compaction,inputTokensAfter}')::bigint), 0) AS input_tokens_after,
            SUM(CASE WHEN COALESCE((e.payload #>> '{compaction,retained,hardFieldLoss}')::boolean, false) THEN 1 ELSE 0 END) AS hard_field_losses
        FROM agent_events e
        JOIN agent_runs r ON r.id = e.run_id
        WHERE e.event_type = 'context.compacted'
          AND jsonb_exists(e.payload, 'compaction')
          AND ${baseWhere}
    `, params);
    const inputTokensBefore = Number(summary?.input_tokens_before || 0);
    const inputTokensAfter = Number(summary?.input_tokens_after || 0);
    return {
        days: safeDays,
        eventCount: Number(summary?.event_count || 0),
        runCount: Number(summary?.run_count || 0),
        inputTokensBefore,
        inputTokensAfter,
        savingsRate: inputTokensBefore > 0 ? Math.max(0, (inputTokensBefore - inputTokensAfter) / inputTokensBefore) : null,
        hardFieldLosses: Number(summary?.hard_field_losses || 0)
    };
}

module.exports = {
    assessAgentRuntimeSlo,
    getAgentContextCompactionMetrics,
    getAgentMetrics,
    runAgentRuntimeSloMonitor,
    getAgentRuntimeStatus
};
