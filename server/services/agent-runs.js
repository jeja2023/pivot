const { db } = require('../db');
const {
    ACTIVE_STATUSES,
    parseJsonObject,
    normalizeMaxSteps
} = require('./agent-validators');
const { isSuperAdmin } = require('../permissions');

function getRunForUser(runId, user, options = {}) {
    const includeDeleted = Boolean(options.includeDeleted);
    return db.prepare(`
        SELECT * FROM agent_runs
        WHERE id = ? AND user_id = ?
          ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `).get(runId, user.id);
}

function listRuns(user, options = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(options.limit, 10) || 10, 1), 100);
    const safePage = Math.max(Number.parseInt(options.page, 10) || 1, 1);
    const offset = (safePage - 1) * safeLimit;
    const status = String(options.status || '').trim();
    const query = String(options.query || '').trim();
    const where = ['r.user_id = ?', 'r.deleted_at IS NULL'];
    const params = [user.id];
    if (status) {
        where.push('r.status = ?');
        params.push(status);
    }
    if (query) {
        where.push('(r.title LIKE ? OR r.goal LIKE ? OR m.name LIKE ?)');
        const pattern = `%${query}%`;
        params.push(pattern, pattern, pattern);
    }
    const whereSql = where.join('\n          AND ');
    const total = db.prepare(`
        SELECT COUNT(*) AS count
        FROM agent_runs r
        LEFT JOIN models m ON m.id = r.model_id
        WHERE ${whereSql}
    `).get(...params)?.count || 0;
    const data = db.prepare(`
        WITH filtered_runs AS (
            SELECT r.id, r.session_id, r.model_id, r.title, r.goal, r.status, r.final_answer, r.error_message,
                   r.max_steps, r.parent_run_id, r.priority, r.run_mode, r.tool_policy, r.tool_allowlist,
                   r.approval_policy, r.timeout_ms, r.tool_timeout_ms, r.retry_limit, r.retry_count,
                   r.max_token_budget, r.export_count, r.template_id, r.schedule_id, r.context_config, r.resume_from_step,
                   r.started_at, r.last_heartbeat_at, r.input_tokens, r.output_tokens, r.total_tokens,
                   r.cancelled_at, r.created_at, r.updated_at, r.completed_at,
                   m.name AS model_name
            FROM agent_runs r
            LEFT JOIN models m ON m.id = r.model_id
            WHERE ${whereSql}
            ORDER BY r.created_at DESC
            LIMIT ?
            OFFSET ?
        ),
        step_stats AS (
            SELECT s.run_id,
                   COUNT(*) AS step_count,
                   SUM(CASE WHEN s.type = 'tool' THEN 1 ELSE 0 END) AS tool_count,
                   SUM(CASE WHEN s.status = 'error' THEN 1 ELSE 0 END) AS error_count
            FROM agent_steps s
            JOIN filtered_runs fr ON fr.id = s.run_id
            GROUP BY s.run_id
        )
        SELECT fr.*,
               COALESCE(ss.step_count, 0) AS step_count,
               COALESCE(ss.tool_count, 0) AS tool_count,
               COALESCE(ss.error_count, 0) AS error_count
        FROM filtered_runs fr
        LEFT JOIN step_stats ss ON ss.run_id = fr.id
        ORDER BY fr.created_at DESC
    `).all(...params, safeLimit, offset);
    return { data, total, page: safePage, limit: safeLimit };
}

function listDeletedRunsForAdmin(user, limit = 100) {
    if (!isSuperAdmin(user)) {
        const err = new Error('仅 admin 权限层级可查看智能体任务删除审计。');
        err.status = 403;
        throw err;
    }
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
    return db.prepare(`
        SELECT r.id, r.user_id, u.username, u.nickname, u.unit, r.session_id, r.model_id,
               m.name AS model_name, r.title, r.goal, r.status, r.error_message, r.max_steps,
               r.parent_run_id, r.priority, r.run_mode, r.tool_policy, r.approval_policy,
               r.timeout_ms, r.tool_timeout_ms, r.retry_limit, r.retry_count, r.max_token_budget, r.export_count,
               r.started_at, r.last_heartbeat_at,
               r.input_tokens, r.output_tokens, r.total_tokens,
               r.cancelled_at, r.created_at, r.updated_at, r.completed_at,
               r.deleted_at, r.deleted_by_user, r.delete_reason,
               du.username AS deleted_by_username, du.nickname AS deleted_by_nickname,
               (SELECT COUNT(*) FROM agent_steps s WHERE s.run_id = r.id) AS step_count,
               (SELECT COUNT(*) FROM agent_steps s WHERE s.run_id = r.id AND s.type = 'tool') AS tool_count,
               (SELECT COUNT(*) FROM agent_steps s WHERE s.run_id = r.id AND s.status = 'error') AS error_count
        FROM agent_runs r
        LEFT JOIN users u ON u.id = r.user_id
        LEFT JOIN users du ON du.id = r.deleted_by_user
        LEFT JOIN models m ON m.id = r.model_id
        WHERE r.deleted_at IS NOT NULL
        ORDER BY r.deleted_at DESC
        LIMIT ?
    `).all(safeLimit);
}

function listSteps(runId) {
    return db.prepare(`
        SELECT id, step_index, type, title, tool_name, input, output, error_message, status, duration_ms, started_at, completed_at, created_at
        FROM agent_steps
        WHERE run_id = ?
        ORDER BY step_index ASC, id ASC
    `).all(runId).map(step => ({
        ...step,
        input: parseJsonObject(step.input) || step.input,
        output: parseJsonObject(step.output) || step.output
    }));
}

function listDagNodes(runId) {
    return db.prepare(`
        SELECT id, run_id, node_key, title, tool_name, input, depends_on, condition, status,
               output, error_message, attempt_count, duration_ms, started_at, completed_at, created_at
        FROM agent_dag_nodes
        WHERE run_id = ?
        ORDER BY id ASC
    `).all(runId).map(node => ({
        ...node,
        input: parseJsonObject(node.input) || {},
        depends_on: parseJsonObject(node.depends_on) || [],
        output: parseJsonObject(node.output) || node.output
    }));
}

function getRunProgress(run, steps = []) {
    const maxSteps = normalizeMaxSteps(run?.max_steps);
    const planCount = steps.filter(step => step.type === 'plan').length;
    const toolCount = steps.filter(step => step.type === 'tool').length;
    const errorCount = steps.filter(step => step.status === 'error').length;
    const totalDurationMs = steps.reduce((sum, step) => sum + (Number(step.duration_ms) || 0), 0);
    const active = run && ACTIVE_STATUSES.has(run.status);
    return {
        maxSteps,
        planCount,
        toolCount,
        errorCount,
        stepCount: steps.length,
        totalDurationMs,
        isLimitReached: active && Math.max(planCount, toolCount) >= maxSteps,
        percent: active ? Math.min(Math.round((Math.max(planCount, toolCount) / maxSteps) * 100), 95) : (run?.status === 'completed' ? 100 : 0)
    };
}

function getRunDetailForUser(runId, user) {
    const run = getRunForUser(runId, user);
    if (!run) return null;
    const steps = listSteps(run.id);
    return { run, steps, dagNodes: listDagNodes(run.id), progress: getRunProgress(run, steps) };
}

module.exports = {
    getRunDetailForUser,
    getRunForUser,
    getRunProgress,
    listDagNodes,
    listDeletedRunsForAdmin,
    listRuns,
    listSteps
};
