const { queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { getPrimaryTenantId } = require('./enterprise-access');

async function getAgentQualityDashboard(user, options = {}) {
    const days = Math.max(1, Math.min(Number.parseInt(options.days, 10) || 30, 365));
    const tenantId = user.tenant_id || await getPrimaryTenantId(user.id);
    const cutoff = getBeijingTimestamp(new Date(Date.now() - days * 86400000));
    const [runs, approvals, tools, deliveries, goals] = await Promise.all([
        queryOne('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = \'completed\') AS completed, COUNT(*) FILTER (WHERE status IN (\'error\', \'failed\')) AS failed, AVG(EXTRACT(EPOCH FROM (COALESCE(completed_at, updated_at) - created_at))) AS avg_seconds FROM agent_runs WHERE created_at >= ? AND (tenant_id IS NULL OR tenant_id = ?) AND (? = true OR user_id = ?)', [cutoff, tenantId, ['admin', 'root'].includes(String(user.role || '').toLowerCase()), user.id]),
        queryOne('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = \'approved\') AS approved, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (decided_at - created_at))) AS median_seconds FROM agent_approval_requests WHERE created_at >= ? AND (user_id = ? OR ? = true)', [cutoff, user.id, ['admin', 'root'].includes(String(user.role || '').toLowerCase())]),
        queryOne('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status IN (\'success\', \'completed\')) AS success, COUNT(*) FILTER (WHERE status IN (\'error\', \'failed\', \'denied\')) AS errors FROM agent_tool_calls WHERE created_at >= ? AND (tenant_id IS NULL OR tenant_id = ?) ', [cutoff, tenantId]),
        queryOne('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = \'delivered\') AS delivered, COUNT(*) FILTER (WHERE status = \'dead_letter\') AS dead_letter FROM agent_channel_deliveries WHERE created_at >= ? AND (tenant_id IS NULL OR tenant_id = ?)', [cutoff, tenantId]),
        queryOne('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = \'paused\') AS paused, COUNT(*) FILTER (WHERE status = \'active\') AS active FROM agent_goals WHERE created_at >= ? AND (tenant_id IS NULL OR tenant_id = ?)', [cutoff, tenantId])
    ]);
    const total = Number(runs?.total || 0);
    return { generatedAt: getBeijingTimestamp(), days, tenantId, runs: { total, completed: Number(runs?.completed || 0), failed: Number(runs?.failed || 0), successRate: total ? Number(runs.completed || 0) / total : 1, averageSeconds: Number(runs?.avg_seconds || 0) }, approvals: { total: Number(approvals?.total || 0), approved: Number(approvals?.approved || 0), approvalRate: Number(approvals?.total || 0) ? Number(approvals.approved || 0) / Number(approvals.total) : 1, medianSeconds: Number(approvals?.median_seconds || 0) }, tools: { total: Number(tools?.total || 0), success: Number(tools?.success || 0), errors: Number(tools?.errors || 0), errorRate: Number(tools?.total || 0) ? Number(tools.errors || 0) / Number(tools.total) : 0 }, deliveries: { total: Number(deliveries?.total || 0), delivered: Number(deliveries?.delivered || 0), deadLetter: Number(deliveries?.dead_letter || 0) }, goals: { total: Number(goals?.total || 0), active: Number(goals?.active || 0), paused: Number(goals?.paused || 0) } };
}

module.exports = { getAgentQualityDashboard };
