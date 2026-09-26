const { queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { getPrimaryTenantId } = require('./enterprise-access');

async function getAgentQualityDashboard(user, options = {}) {
    const days = Math.max(1, Math.min(Number.parseInt(options.days, 10) || 30, 365));
    const tenantId = user.tenant_id || await getPrimaryTenantId(user.id);
    const cutoff = getBeijingTimestamp(new Date(Date.now() - days * 86400000));
    const isAdmin = ['admin', 'root'].includes(String(user.role || '').toLowerCase());
    const [runs, verifications, approvals, tools, deliveries, goals] = await Promise.all([
        queryOne('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status IN (\'completed\', \'completed_with_errors\', \'partial\')) AS terminal, COUNT(*) FILTER (WHERE status = \'completed\') AS completed, COUNT(*) FILTER (WHERE status IN (\'error\', \'failed\')) AS failed, AVG(EXTRACT(EPOCH FROM (COALESCE(completed_at, updated_at) - created_at))) AS avg_seconds FROM agent_runs WHERE created_at >= ? AND (tenant_id IS NULL OR tenant_id = ?) AND (? = true OR user_id = ?)', [cutoff, tenantId, isAdmin, user.id]),
        queryOne(`SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE v.outcome_status = 'verified') AS verified,
            COUNT(*) FILTER (WHERE v.outcome_status = 'partial') AS partial,
            COUNT(*) FILTER (WHERE v.outcome_status = 'needs_input') AS needs_input
            FROM agent_verifications v JOIN agent_runs r ON r.id = v.run_id
            WHERE v.created_at >= ? AND (r.tenant_id IS NULL OR r.tenant_id = ?) AND (? = true OR r.user_id = ?)`, [cutoff, tenantId, isAdmin, user.id]),
        queryOne(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE ar.status = 'approved') AS approved,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (ar.decided_at - ar.created_at))) AS median_seconds
            FROM agent_approval_requests ar JOIN agent_runs r ON r.id = ar.run_id
            WHERE ar.created_at >= ? AND (r.tenant_id IS NULL OR r.tenant_id = ?) AND (? = true OR r.user_id = ?)`, [cutoff, tenantId, isAdmin, user.id]),
        queryOne(`SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE c.status IN ('success', 'completed')) AS success,
            COUNT(*) FILTER (WHERE c.status IN ('error', 'failed', 'denied')) AS errors
            FROM agent_tool_calls c
            JOIN agent_runs r ON r.id = c.run_id
            WHERE c.created_at >= ? AND (r.tenant_id IS NULL OR r.tenant_id = ?)
              AND (? = true OR r.user_id = ?)`, [cutoff, tenantId, isAdmin, user.id]),
        queryOne('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = \'delivered\') AS delivered, COUNT(*) FILTER (WHERE status = \'dead_letter\') AS dead_letter FROM agent_channel_deliveries WHERE created_at >= ? AND (tenant_id IS NULL OR tenant_id = ?)', [cutoff, tenantId]),
        queryOne('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = \'paused\') AS paused, COUNT(*) FILTER (WHERE status = \'active\') AS active FROM agent_goals WHERE created_at >= ? AND (tenant_id IS NULL OR tenant_id = ?)', [cutoff, tenantId])
    ]);
    const total = Number(runs?.total || 0);
    const verificationTotal = Number(verifications?.total || 0);
    return {
        generatedAt: getBeijingTimestamp(),
        days,
        tenantId,
        runs: {
            total,
            terminal: Number(runs?.terminal || 0),
            completed: Number(runs?.completed || 0),
            failed: Number(runs?.failed || 0),
            executionCompletionRate: total ? Number(runs?.terminal || 0) / total : null,
            averageSeconds: total ? Number(runs?.avg_seconds || 0) : null
        },
        verification: {
            total: verificationTotal,
            verified: Number(verifications?.verified || 0),
            partial: Number(verifications?.partial || 0),
            needsInput: Number(verifications?.needs_input || 0),
            verifiedRate: verificationTotal ? Number(verifications?.verified || 0) / verificationTotal : null
        },
        approvals: { total: Number(approvals?.total || 0), approved: Number(approvals?.approved || 0), approvalRate: Number(approvals?.total || 0) ? Number(approvals.approved || 0) / Number(approvals.total) : null, medianSeconds: Number(approvals?.total || 0) ? Number(approvals?.median_seconds || 0) : null },
        tools: { total: Number(tools?.total || 0), success: Number(tools?.success || 0), errors: Number(tools?.errors || 0), errorRate: Number(tools?.total || 0) ? Number(tools.errors || 0) / Number(tools.total) : null },
        deliveries: { total: Number(deliveries?.total || 0), delivered: Number(deliveries?.delivered || 0), deadLetter: Number(deliveries?.dead_letter || 0) },
        goals: { total: Number(goals?.total || 0), active: Number(goals?.active || 0), paused: Number(goals?.paused || 0) }
    };
}

module.exports = { getAgentQualityDashboard };
