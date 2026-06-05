const { db } = require('../db');
const { normalizePositiveInt } = require('./agent-validators');
const { isSuperAdmin } = require('../permissions');

function getAgentRuntimeStatus(options = {}) {
    const user = options.user || null;
    const queueStatus = options.queueStatus || {};
    const maxConcurrent = normalizePositiveInt(options.maxConcurrent, 1, 1, 1000);
    const queuedTotal = db.prepare(`
        SELECT COUNT(*) AS count FROM agent_runs
        WHERE status = 'queued' AND deleted_at IS NULL
    `).get().count || 0;
    const userQueued = user?.id ? db.prepare(`
        SELECT COUNT(*) AS count FROM agent_runs
        WHERE status = 'queued' AND deleted_at IS NULL AND user_id = ?
    `).get(user.id).count || 0 : 0;
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

function getAgentMetrics(user, days = 7) {
    const safeDays = normalizePositiveInt(days, 7, 1, 90);
    const params = [user.id, `-${safeDays} days`];
    const superAdmin = isSuperAdmin(user);
    const baseWhere = superAdmin
        ? "created_at >= datetime('now', '+8 hours', ?)"
        : "user_id = ? AND created_at >= datetime('now', '+8 hours', ?)";
    const actualParams = superAdmin ? [`-${safeDays} days`] : params;
    const summary = db.prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
            SUM(CASE WHEN status IN ('queued','running','approval_required') THEN 1 ELSE 0 END) AS active,
            COALESCE(SUM(total_tokens), 0) AS totalTokens
        FROM agent_runs
        WHERE deleted_at IS NULL AND ${baseWhere}
    `).get(...actualParams);
    const toolStats = db.prepare(`
        SELECT s.tool_name, COUNT(*) AS count
        FROM agent_steps s
        JOIN agent_runs r ON r.id = s.run_id
        WHERE r.deleted_at IS NULL AND s.type = 'tool' AND ${baseWhere.replace(/created_at/g, 'r.created_at')}
        GROUP BY s.tool_name
        ORDER BY count DESC
        LIMIT 10
    `).all(...actualParams);
    return {
        days: safeDays,
        total: Number(summary.total || 0),
        completed: Number(summary.completed || 0),
        error: Number(summary.error || 0),
        cancelled: Number(summary.cancelled || 0),
        active: Number(summary.active || 0),
        successRate: Number(summary.total || 0) ? Math.round((Number(summary.completed || 0) / Number(summary.total || 0)) * 100) : 0,
        totalTokens: Number(summary.totalTokens || 0),
        toolStats
    };
}

module.exports = {
    getAgentMetrics,
    getAgentRuntimeStatus
};
