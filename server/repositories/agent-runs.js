/**
 * server/repositories/agent-runs.js
 * 智能体运行记录数据访问层（SQLite / PostgreSQL 双方言）
 *
 * 全部接口返回 Promise，方言差异统一由 db/dialect.js 抽象。
 */
const { query, queryOne, execute } = require('../db/client');
const { jsonExtract, jsonValid, likeOperator } = require('../db/dialect');
const { parseJsonObject } = require('../services/agent-validators');

function normalizeBooleanOption(value) {
    if (value === true) return true;
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

/**
 * 排除预览运行与评测运行的过滤条件。
 * metadata 是 TEXT 列且历史数据可能非法，故两侧都需容错取值：
 * SQLite 靠 json_valid 守卫，PG 靠 pivot_json_extract 内建异常捕获。
 */
function previewRunFilterSql(alias = 'r') {
    return `((CASE
        WHEN ${alias}.metadata IS NOT NULL AND ${alias}.metadata != '' AND ${jsonValid(`${alias}.metadata`)}
        THEN lower(COALESCE(
            ${jsonExtract(`${alias}.metadata`, '$.workflowRunSource')},
            ${jsonExtract(`${alias}.metadata`, '$.workflow_run_source')},
            ${jsonExtract(`${alias}.metadata`, '$.runSource')},
            ''
        ))
        ELSE ''
    END) != 'preview'
    AND (CASE
        WHEN ${alias}.metadata IS NOT NULL AND ${alias}.metadata != '' AND ${jsonValid(`${alias}.metadata`)}
        THEN ${jsonExtract(`${alias}.metadata`, '$.evaluation.evalRunId')}
        ELSE NULL
    END) IS NULL)`;
}

function normalizeRunTypeFilter(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (['free', 'standard', 'quick'].includes(normalized)) return 'free';
    if (['workflow', 'dag'].includes(normalized)) return 'workflow';
    if (['scheduled', 'schedule'].includes(normalized)) return 'scheduled';
    return '';
}

async function getRunById(runId, { includeDeleted = false } = {}) {
    const row = await queryOne(
        `SELECT * FROM agent_runs WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
        [runId]
    );
    return row || null;
}

function getRunForUser(runId, userId, { includeDeleted = false } = {}) {
    return queryOne(`
        SELECT * FROM agent_runs
        WHERE id = ? AND user_id = ?
          ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `, [runId, userId]);
}

async function listRuns(userId, options = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(options.limit, 10) || 15, 1), 100);
    const safePage = Math.max(Number.parseInt(options.page, 10) || 1, 1);
    const offset = (safePage - 1) * safeLimit;
    const status = String(options.status || '').trim();
    const searchText = String(options.query || '').trim();
    const runType = normalizeRunTypeFilter(options.runType || options.run_type || options.type);
    const where = ['r.user_id = ?', 'r.deleted_at IS NULL'];
    const params = [userId];
    const scheduleId = options.scheduleId === undefined || options.scheduleId === null || options.scheduleId === ''
        ? null
        : Number(options.scheduleId);
    if (scheduleId !== null && Number.isInteger(scheduleId) && scheduleId > 0) {
        where.push('r.schedule_id = ?');
        params.push(scheduleId);
    }
    if (!normalizeBooleanOption(options.includePreview)) {
        where.push(previewRunFilterSql('r'));
    }
    if (status) {
        where.push('r.status = ?');
        params.push(status);
    }
    if (runType === 'workflow') {
        where.push("r.run_mode = 'dag' AND r.schedule_id IS NULL");
    } else if (runType === 'free') {
        where.push("r.run_mode != 'dag' AND r.schedule_id IS NULL");
    } else if (runType === 'scheduled') {
        where.push('r.schedule_id IS NOT NULL');
    }
    if (searchText) {
        const like = likeOperator();
        where.push(`(r.title ${like} ? OR r.goal ${like} ? OR m.name ${like} ?)`);
        const pattern = `%${searchText}%`;
        params.push(pattern, pattern, pattern);
    }
    const whereSql = where.join('\n          AND ');

    const totalRow = await queryOne(`
        SELECT COUNT(*) AS count
        FROM agent_runs r
        LEFT JOIN models m ON m.id = r.model_id
        WHERE ${whereSql}
    `, params);
    const total = Number(totalRow?.count || 0);

    const data = await query(`
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
    `, [...params, safeLimit, offset]);

    return { data, total, page: safePage, limit: safeLimit };
}

function listDeletedRunsForAdmin(limit = 100) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
    return query(`
        SELECT r.id, r.user_id, COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username, u.nickname, u.unit, r.session_id, r.model_id,
               m.name AS model_name, r.title, r.goal, r.status, r.error_message, r.max_steps,
               r.parent_run_id, r.priority, r.run_mode, r.tool_policy, r.approval_policy,
               r.timeout_ms, r.tool_timeout_ms, r.retry_limit, r.retry_count, r.max_token_budget, r.export_count,
               r.started_at, r.last_heartbeat_at,
               r.input_tokens, r.output_tokens, r.total_tokens,
               r.cancelled_at, r.created_at, r.updated_at, r.completed_at,
               r.deleted_at, r.deleted_by_user, r.delete_reason,
               COALESCE(NULLIF(du.deleted_username, ''), du.username) AS deleted_by_username, du.nickname AS deleted_by_nickname,
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
    `, [safeLimit]);
}

async function listSteps(runId) {
    const steps = await query(`
        SELECT id, step_index, type, title, tool_name, input, output, error_message, status, duration_ms, started_at, completed_at, created_at
        FROM agent_steps
        WHERE run_id = ?
        ORDER BY step_index ASC, id ASC
    `, [runId]);
    return steps.map(step => ({
        ...step,
        input: parseJsonObject(step.input) || step.input,
        output: parseJsonObject(step.output) || step.output
    }));
}

async function listDagNodes(runId) {
    // condition 在 PG 中是关键字，需加引号；SQLite 同样接受双引号标识符
    const nodes = await query(`
        SELECT id, run_id, node_key, title, tool_name, input, input_schema, output_schema, depends_on, "condition", status,
               output, error_message, contract_status, contract_issues, attempt_count, duration_ms, started_at, completed_at, created_at
        FROM agent_dag_nodes
        WHERE run_id = ?
        ORDER BY id ASC
    `, [runId]);
    return nodes.map(node => ({
        ...node,
        input: parseJsonObject(node.input) || {},
        input_schema: parseJsonObject(node.input_schema) || {},
        output_schema: parseJsonObject(node.output_schema) || {},
        depends_on: parseJsonObject(node.depends_on) || [],
        contract_issues: parseJsonObject(node.contract_issues) || [],
        output: parseJsonObject(node.output) || node.output
    }));
}

async function updateAgentRunTitleAndGoal(runId, userId, { title, goal } = {}) {
    const run = await getRunForUser(runId, userId);
    if (!run) return null;
    const now = new Date().toISOString();
    const newTitle = title !== undefined ? String(title || '').trim().slice(0, 200) : run.title;
    const newGoal = goal !== undefined ? String(goal || '').trim().slice(0, 12000) : run.goal;
    await execute(`
        UPDATE agent_runs
        SET title = ?, goal = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `, [newTitle, newGoal, now, runId, userId]);
    return getRunForUser(runId, userId);
}

module.exports = {
    getRunById,
    getRunForUser,
    updateAgentRunTitleAndGoal,
    listRuns,
    listDeletedRunsForAdmin,
    listSteps,
    listDagNodes
};
