const { query, queryOne } = require('../db/client');
const { nowOffsetExpr } = require('../db/dialect');
const { normalizePositiveInt } = require('./agent-validators');
const { isSuperAdmin } = require('../permissions');

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
    const timeFilter = nowOffsetExpr(`-${safeDays} days`);
    const baseWhere = superAdmin
        ? `created_at >= ${timeFilter}`
        : `user_id = ? AND created_at >= ${timeFilter}`;
    const actualParams = superAdmin ? [] : [user.id];
    const summary = await queryOne(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'completed_with_errors' THEN 1 ELSE 0 END) AS completedWithErrors,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
            SUM(CASE WHEN status IN ('queued','running','approval_required','awaiting_approval') THEN 1 ELSE 0 END) AS active,
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
        toolStats: toolStats || []
    };
}

module.exports = {
    getAgentMetrics,
    getAgentRuntimeStatus
};
