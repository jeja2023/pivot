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

function normalizeBooleanOption(value) {
    if (value === true) return true;
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function previewRunFilterSql(alias = 'r') {
    return `(CASE
        WHEN ${alias}.metadata IS NOT NULL AND ${alias}.metadata != '' AND json_valid(${alias}.metadata)
        THEN lower(COALESCE(
            json_extract(${alias}.metadata, '$.workflowRunSource'),
            json_extract(${alias}.metadata, '$.workflow_run_source'),
            json_extract(${alias}.metadata, '$.runSource'),
            ''
        ))
        ELSE ''
    END) != 'preview'`;
}

function normalizeRunTypeFilter(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (['free', 'standard', 'quick'].includes(normalized)) return 'free';
    if (['workflow', 'dag'].includes(normalized)) return 'workflow';
    return '';
}

function listRuns(user, options = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(options.limit, 10) || 15, 1), 100);
    const safePage = Math.max(Number.parseInt(options.page, 10) || 1, 1);
    const offset = (safePage - 1) * safeLimit;
    const status = String(options.status || '').trim();
    const query = String(options.query || '').trim();
    const runType = normalizeRunTypeFilter(options.runType || options.run_type || options.type);
    const where = ['r.user_id = ?', 'r.deleted_at IS NULL'];
    const params = [user.id];
    if (!normalizeBooleanOption(options.includePreview)) {
        where.push(previewRunFilterSql('r'));
    }
    if (status) {
        where.push('r.status = ?');
        params.push(status);
    }
    if (runType === 'workflow') {
        where.push("r.run_mode = 'dag'");
    } else if (runType === 'free') {
        where.push("r.run_mode != 'dag'");
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

function safeWorkflowNodeId(value, fallback = 'node') {
    const normalized = String(value || fallback)
        .trim()
        .toLowerCase()
        .replace(/[^\w-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
    return normalized || fallback;
}

function uniqueWorkflowNodeId(used, value, fallback) {
    const base = safeWorkflowNodeId(value, fallback);
    let candidate = base;
    let index = 2;
    while (used.has(candidate)) {
        candidate = `${base}_${index}`;
        index += 1;
    }
    used.add(candidate);
    return candidate;
}

function normalizeWorkflowDraftInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    try {
        return JSON.parse(JSON.stringify(input));
    } catch (e) {
        return {};
    }
}

function buildWorkflowDraftLlmPrompt(run, toolNodes) {
    const referencedOutputs = toolNodes
        .map(node => `- ${node.title}：{{nodes.${node.id}.output}}`)
        .join('\n');
    const upstreamText = referencedOutputs || '- 没有可复用工具节点，请直接围绕 {{goal}} 形成结果。';
    return [
        '请基于自由任务目标和上游节点输出，整理为可交付的中文结果。',
        '',
        '任务目标：{{goal}}',
        '',
        '上游节点输出：',
        upstreamText,
        '',
        '输出要求：',
        '1. 先给结论，再列依据和下一步建议。',
        '2. 明确说明哪些内容来自工具结果，哪些是你的分析。',
        '3. 如果上游结果不足，请指出需要补充的资料或能力。'
    ].join('\n');
}

function buildWorkflowDraftFromRun(run, steps = []) {
    const used = new Set();
    const toolSteps = steps
        .filter(step => step.type === 'tool' && step.tool_name && step.status !== 'error')
        .slice(0, 12);
    const toolNodes = toolSteps.map((step, index) => {
        const id = uniqueWorkflowNodeId(used, step.tool_name || step.title, `tool_${index + 1}`);
        return {
            id,
            title: String(step.title || `执行工具：${step.tool_name}`).replace(/^工具执行完成：/, '').slice(0, 120) || `工具节点 ${index + 1}`,
            tool: step.tool_name,
            input: normalizeWorkflowDraftInput(step.input),
            dependsOn: index === 0 ? [] : [Array.from(used)[index - 1]],
            condition: 'success',
            retryLimit: 1,
            timeoutMs: 0,
            onError: 'skip_dependents'
        };
    });
    const llmId = uniqueWorkflowNodeId(used, 'llm_summary', 'llm_summary');
    const modelId = String(run.model_id || '').trim();
    const llmNode = {
        id: llmId,
        title: '汇总自由任务结果',
        tool: 'agent.llm',
        input: {
            prompt: buildWorkflowDraftLlmPrompt(run, toolNodes),
            model: modelId,
            maxSteps: Number(run.max_steps || 20) || 20
        },
        dependsOn: toolNodes.length ? [toolNodes[toolNodes.length - 1].id] : [],
        condition: 'success',
        retryLimit: 0,
        timeoutMs: 0,
        onError: 'skip_dependents'
    };
    const sourceTitle = String(run.title || run.goal || '').trim();
    return {
        name: `由自由任务生成：${sourceTitle || run.id}`.slice(0, 100),
        description: `从自由任务 ${run.id} 生成的工作流草稿。请在编排页检查节点、参数和发布策略后再用于生产任务。`.slice(0, 300),
        dagSpec: { nodes: [...toolNodes, llmNode] },
        sourceRun: {
            id: run.id,
            title: run.title || '',
            goal: run.goal || '',
            run_mode: run.run_mode || '',
            status: run.status || '',
            model_id: run.model_id || null,
            model_name: run.model_name || ''
        },
        summary: {
            toolNodeCount: toolNodes.length,
            nodeCount: toolNodes.length + 1,
            generatedAt: new Date().toISOString()
        }
    };
}

function createWorkflowDraftFromRun(runId, user) {
    const run = db.prepare(`
        SELECT r.*, m.name AS model_name
        FROM agent_runs r
        LEFT JOIN models m ON m.id = r.model_id
        WHERE r.id = ? AND r.user_id = ? AND r.deleted_at IS NULL
    `).get(runId, user.id);
    if (!run) return null;
    if (String(run.run_mode || '') === 'dag') {
        const err = new Error('工作流任务已经具备编排结构，请直接在工作流页加载或复制。');
        err.status = 400;
        throw err;
    }
    return buildWorkflowDraftFromRun(run, listSteps(run.id));
}

function sortDagNodesByDependencies(nodes = []) {
    const entries = nodes.map((node, index) => ({
        node,
        index,
        key: String(node.node_key || node.id || `__node_${index}`),
        uniqueKey: `${String(node.node_key || node.id || '__node')}::${index}`
    }));
    const keys = new Set(entries.map(entry => entry.key));
    const dependencyKeys = (node) => (Array.isArray(node.depends_on) ? node.depends_on : [])
        .map(dep => String(dep || '').trim())
        .filter(dep => dep && keys.has(dep));
    const ordered = [];
    const placed = new Set();
    const placedKeys = new Set();
    while (ordered.length < entries.length) {
        const remaining = entries.filter(entry => !placed.has(entry.uniqueKey));
        const ready = remaining.filter(entry => dependencyKeys(entry.node).every(dep => placedKeys.has(dep)));
        const layer = ready.length ? ready : remaining;
        layer.sort((a, b) => a.index - b.index);
        layer.forEach(entry => {
            if (placed.has(entry.uniqueKey)) return;
            placed.add(entry.uniqueKey);
            placedKeys.add(entry.key);
            ordered.push(entry.node);
        });
    }
    return ordered;
}

function listDagNodes(runId) {
    const nodes = db.prepare(`
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
    return sortDagNodesByDependencies(nodes);
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
    createWorkflowDraftFromRun,
    getRunDetailForUser,
    getRunForUser,
    getRunProgress,
    listDagNodes,
    listDeletedRunsForAdmin,
    listRuns,
    sortDagNodesByDependencies,
    listSteps
};
