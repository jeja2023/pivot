const crypto = require('crypto');
const axios = require('axios');
const { db } = require('../db');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { estimateTokens } = require('../llm');
const { getRunnableModelForUser, recordModelTokenUsage } = require('./models');
const { buildChatCompletionsUrl, buildModelHeaders } = require('./model-adapter');
const { clampText, executeBuiltInTool, getBuiltInToolDefinitions } = require('./agent-tools');
const { executeMcpTool, listCachedMcpTools } = require('./mcp-client');

const MAX_STEPS = 8;
const DEFAULT_STEPS = 5;
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const MAX_GOAL_LENGTH = 2000;
const SCHEDULE_FREQUENCIES = new Set(['manual', 'daily', 'weekly']);
const AGENT_MAX_CONCURRENT_RUNS = Math.max(Number.parseInt(process.env.AGENT_MAX_CONCURRENT_RUNS || '2', 10) || 2, 1);
const AGENT_DEFAULT_TIMEOUT_MS = Math.max(Number.parseInt(process.env.AGENT_RUN_TIMEOUT_MS || '600000', 10) || 600000, 60000);
const AGENT_TOOL_TIMEOUT_MS = Math.max(Number.parseInt(process.env.AGENT_TOOL_TIMEOUT_MS || '120000', 10) || 120000, 30000);
const AGENT_STALE_RUNNING_MINUTES = Math.max(Number.parseInt(process.env.AGENT_STALE_RUNNING_MINUTES || '30', 10) || 30, 5);
const TOOL_POLICIES = new Set(['all', 'builtin_only']);
const RUN_MODES = new Set(['standard', 'deep', 'audit']);
const APPROVAL_POLICIES = new Set(['safe_mcp_auto', 'approve_all_mcp']);
const activeAgentRuns = new Set();
const pendingAgentQueue = [];

function createRunId() {
    return `run_${crypto.randomBytes(12).toString('hex')}`;
}

function parseJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (e) {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            return JSON.parse(match[0]);
        } catch (err) {
            return null;
        }
    }
}

function normalizeMaxSteps(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STEPS;
    return Math.min(parsed, MAX_STEPS);
}

function normalizePriority(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(Math.min(parsed, 9), -9);
}

function normalizeRunMode(value) {
    const mode = String(value || 'standard').trim();
    return RUN_MODES.has(mode) ? mode : 'standard';
}

function normalizeToolPolicy(value) {
    const policy = String(value || 'all').trim();
    return TOOL_POLICIES.has(policy) ? policy : 'all';
}

function normalizeApprovalPolicy(value) {
    const policy = String(value || 'safe_mcp_auto').trim();
    return APPROVAL_POLICIES.has(policy) ? policy : 'safe_mcp_auto';
}

function normalizePositiveInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return Math.min(parsed, max);
}

function normalizeScheduleFrequency(value) {
    const frequency = String(value || 'manual').trim();
    return SCHEDULE_FREQUENCIES.has(frequency) ? frequency : 'manual';
}

function normalizeContextConfig(value) {
    let parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch (e) {
            parsed = { mode: value };
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
    const mode = ['none', 'auto', 'recent', 'knowledge', 'custom'].includes(String(parsed.mode || 'auto'))
        ? String(parsed.mode || 'auto')
        : 'auto';
    return {
        mode,
        notes: String(parsed.notes || '').trim().slice(0, 1000)
    };
}

function serializeContextConfig(value) {
    return JSON.stringify(normalizeContextConfig(value));
}

function withTimeout(promise, timeoutMs, label = '操作') {
    const safeTimeout = Math.max(Number(timeoutMs) || 0, 1000);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const err = new Error(`${label}超时`);
            err.code = 'AGENT_TIMEOUT';
            reject(err);
        }, safeTimeout);
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            err => {
                clearTimeout(timer);
                reject(err);
            }
        );
    });
}

function normalizeToolAllowlist(value) {
    let list = value;
    if (typeof value === 'string') {
        try {
            list = JSON.parse(value);
        } catch (e) {
            list = value.split(',');
        }
    }
    if (!Array.isArray(list)) return [];
    return [...new Set(list
        .map(item => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 80))];
}

function serializeToolAllowlist(value) {
    const list = normalizeToolAllowlist(value);
    return list.length ? JSON.stringify(list) : '';
}

function normalizeAgentGoal(goal) {
    const cleanGoal = String(goal || '').trim();
    if (cleanGoal.length < 4) {
        const err = new Error('请填写更明确的智能体目标。');
        err.status = 400;
        throw err;
    }
    if (cleanGoal.length > MAX_GOAL_LENGTH) {
        const err = new Error(`智能体目标不能超过 ${MAX_GOAL_LENGTH} 个字符。`);
        err.status = 400;
        throw err;
    }
    return cleanGoal;
}

function getRunForUser(runId, user, options = {}) {
    const includeDeleted = Boolean(options.includeDeleted);
    return db.prepare(`
        SELECT * FROM agent_runs
        WHERE id = ? AND user_id = ?
          ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `).get(runId, user.id);
}

function listRuns(user, limit = 30) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 30, 1), 100);
    return db.prepare(`
        SELECT r.id, r.session_id, r.model_id, r.title, r.goal, r.status, r.final_answer, r.error_message,
               r.max_steps, r.parent_run_id, r.priority, r.run_mode, r.tool_policy, r.tool_allowlist,
               r.approval_policy, r.timeout_ms, r.tool_timeout_ms, r.retry_limit, r.retry_count,
               r.max_token_budget, r.export_count, r.template_id, r.schedule_id, r.context_config, r.resume_from_step,
               r.started_at, r.last_heartbeat_at, r.input_tokens, r.output_tokens, r.total_tokens,
               r.cancelled_at, r.created_at, r.updated_at, r.completed_at,
               m.name AS model_name,
               (SELECT COUNT(*) FROM agent_steps s WHERE s.run_id = r.id) AS step_count,
               (SELECT COUNT(*) FROM agent_steps s WHERE s.run_id = r.id AND s.type = 'tool') AS tool_count,
               (SELECT COUNT(*) FROM agent_steps s WHERE s.run_id = r.id AND s.status = 'error') AS error_count
        FROM agent_runs r
        LEFT JOIN models m ON m.id = r.model_id
        WHERE r.user_id = ?
          AND r.deleted_at IS NULL
        ORDER BY r.created_at DESC
        LIMIT ?
    `).all(user.id, safeLimit);
}

function listDeletedRunsForAdmin(user, limit = 100) {
    if (user?.username !== 'admin') {
        const err = new Error('仅 admin 超级管理员可查看智能体任务删除审计。');
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

function updateRun(runId, fields = {}) {
    const allowed = [
        'status', 'final_answer', 'error_message', 'completed_at', 'updated_at', 'title',
        'cancelled_at', 'deleted_at', 'deleted_by_user', 'delete_reason', 'started_at',
        'last_heartbeat_at', 'priority', 'run_mode', 'tool_policy', 'tool_allowlist',
        'approval_policy', 'timeout_ms', 'tool_timeout_ms', 'retry_limit', 'retry_count',
        'max_token_budget', 'export_count', 'template_id', 'schedule_id', 'context_config',
        'resume_from_step', 'metadata', 'input_tokens', 'output_tokens', 'total_tokens'
    ];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    if (entries.length === 0) return;
    const set = entries.map(([key]) => `${key} = ?`).join(', ');
    db.prepare(`UPDATE agent_runs SET ${set} WHERE id = ?`).run(...entries.map(([, value]) => value), runId);
}

function getRunStatus(runId) {
    return db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId)?.status || '';
}

function getRunUser(runId) {
    return db.prepare('SELECT u.id, u.username, u.nickname, u.unit, u.role FROM agent_runs r JOIN users u ON u.id = r.user_id WHERE r.id = ?').get(runId);
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
        percent: active ? Math.min(Math.round((Math.max(planCount, toolCount) / maxSteps) * 100), 95) : (run?.status === 'completed' ? 100 : 0)
    };
}

function getRunMetadata(run) {
    const parsed = parseJsonObject(run?.metadata);
    return parsed && typeof parsed === 'object' ? parsed : {};
}

function createAgentNotification(userId, runId, type, title, body = '') {
    if (!userId || !title) return null;
    const info = db.prepare(`
        INSERT INTO agent_notifications (user_id, run_id, type, title, body, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'unread', ?)
    `).run(
        userId,
        runId || null,
        String(type || 'info').slice(0, 40),
        String(title || '').slice(0, 160),
        String(body || '').slice(0, 1000),
        getBeijingTimestamp()
    );
    return db.prepare('SELECT * FROM agent_notifications WHERE id = ?').get(info.lastInsertRowid);
}

function setRunMetadata(runId, patch = {}) {
    const row = db.prepare('SELECT metadata FROM agent_runs WHERE id = ?').get(runId) || {};
    const current = parseJsonObject(row.metadata) || {};
    updateRun(runId, { metadata: JSON.stringify({ ...current, ...patch }), updated_at: getBeijingTimestamp() });
}

function getRunDetailForUser(runId, user) {
    const run = getRunForUser(runId, user);
    if (!run) return null;
    const steps = listSteps(run.id);
    return { run, steps, progress: getRunProgress(run, steps) };
}

function isRunCancelled(runId) {
    return getRunStatus(runId) === 'cancelled';
}

function assertRunNotCancelled(runId) {
    if (isRunCancelled(runId)) {
        const err = new Error('智能体任务已停止。');
        err.code = 'AGENT_RUN_CANCELLED';
        throw err;
    }
}

function cancelAgentRun(runId, user) {
    const run = getRunForUser(runId, user);
    if (!run) return null;
    if (!ACTIVE_STATUSES.has(run.status)) return run;
    const now = getBeijingTimestamp();
    updateRun(runId, {
        status: 'cancelled',
        error_message: '用户已停止任务。',
        cancelled_at: now,
        completed_at: now,
        updated_at: now
    });
    insertStep(runId, listSteps(runId).length + 1, {
        type: 'control',
        title: '用户停止任务',
        output: { status: 'cancelled' }
    });
    createAgentNotification(user.id, runId, 'cancelled', '智能体任务已停止', run.title || run.goal);
    return getRunForUser(runId, user);
}

function createChildRunFromExisting(run, user) {
    return createAgentRun({
        user,
        goal: run.goal,
        modelId: run.model_id,
        sessionId: run.session_id,
        title: run.title,
        maxSteps: run.max_steps,
        priority: run.priority,
        runMode: run.run_mode,
        toolPolicy: run.tool_policy,
        approvalPolicy: run.approval_policy,
        toolAllowlist: normalizeToolAllowlist(run.tool_allowlist),
        timeoutMs: run.timeout_ms,
        toolTimeoutMs: run.tool_timeout_ms,
        retryLimit: run.retry_limit,
        maxTokenBudget: run.max_token_budget,
        templateId: run.template_id,
        scheduleId: run.schedule_id,
        contextConfig: parseJsonObject(run.context_config) || {},
        parentRunId: run.id
    });
}

function rerunAgentRun(runId, user) {
    const run = getRunForUser(runId, user);
    if (!run) return null;
    return createChildRunFromExisting(run, user);
}

function resumeAgentRun(runId, user) {
    const run = getRunForUser(runId, user);
    if (!run) return null;
    if (ACTIVE_STATUSES.has(run.status) || run.status === 'approval_required') {
        const err = new Error('当前任务仍在执行中，无需断点续跑。');
        err.status = 400;
        throw err;
    }
    const steps = listSteps(run.id);
    const lastStep = steps.length ? Math.max(...steps.map(step => Number(step.step_index || 0))) : 0;
    const failed = steps.filter(step => step.status === 'error').slice(-3);
    const resumeGoal = [
        run.goal,
        '',
        '请从上一轮任务的执行结果继续，不要重复已经成功完成的检查。',
        `上一轮状态：${run.status}`,
        run.final_answer ? `上一轮结论：${clampText(run.final_answer, 1200)}` : '',
        run.error_message ? `上一轮错误：${run.error_message}` : '',
        failed.length ? `最近失败步骤：${JSON.stringify(failed.map(step => ({ step: step.step_index, tool: step.tool_name, error: step.error_message })))}` : ''
    ].filter(Boolean).join('\n');
    return createAgentRun({
        user,
        goal: resumeGoal,
        modelId: run.model_id,
        sessionId: run.session_id,
        title: `继续：${run.title || run.goal}`.slice(0, 80),
        maxSteps: run.max_steps,
        priority: run.priority,
        runMode: run.run_mode,
        toolPolicy: run.tool_policy,
        approvalPolicy: run.approval_policy,
        toolAllowlist: normalizeToolAllowlist(run.tool_allowlist),
        timeoutMs: run.timeout_ms,
        toolTimeoutMs: run.tool_timeout_ms,
        retryLimit: run.retry_limit,
        maxTokenBudget: run.max_token_budget,
        templateId: run.template_id,
        scheduleId: run.schedule_id,
        contextConfig: parseJsonObject(run.context_config) || {},
        resumeFromStep: lastStep,
        parentRunId: run.id,
        metadata: { resumedFromRunId: run.id, failedSteps: failed.map(step => step.id) }
    });
}

function softDeleteAgentRun(runId, user, reason = '') {
    const run = getRunForUser(runId, user);
    if (!run) return null;
    if (ACTIVE_STATUSES.has(run.status)) {
        const err = new Error('请先停止正在运行的智能体任务，再移除记录。');
        err.status = 400;
        throw err;
    }
    const now = getBeijingTimestamp();
    updateRun(runId, {
        deleted_at: now,
        deleted_by_user: user.id,
        delete_reason: String(reason || '').trim().slice(0, 500),
        updated_at: now
    });
    insertStep(runId, listSteps(runId).length + 1, {
        type: 'control',
        title: '用户移除任务记录',
        output: {
            status: 'deleted',
            deletedAt: now,
            deletedBy: user.username || user.id
        }
    });
    return getRunForUser(runId, user, { includeDeleted: true });
}

function insertStep(runId, stepIndex, data = {}) {
    const now = getBeijingTimestamp();
    db.prepare(`
        INSERT INTO agent_steps (
            run_id, step_index, type, title, tool_name, input, output, error_message,
            status, duration_ms, started_at, completed_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        runId,
        stepIndex,
        data.type || 'note',
        data.title || '',
        data.toolName || '',
        data.input === undefined ? '' : JSON.stringify(data.input),
        data.output === undefined ? '' : JSON.stringify(data.output),
        data.errorMessage || '',
        data.status || 'success',
        Number(data.durationMs) || 0,
        data.startedAt || now,
        data.completedAt || now,
        now
    );
}

function formatToolList(user, options = {}) {
    const policy = normalizeToolPolicy(options.toolPolicy);
    const allowlist = normalizeToolAllowlist(options.toolAllowlist);
    const allowed = allowlist.length ? new Set(allowlist) : null;
    const isAllowed = (name, source) => {
        if (policy === 'builtin_only' && source === 'mcp') return false;
        if (allowed && !allowed.has(name)) return false;
        return true;
    };
    const builtIns = getBuiltInToolDefinitions(user).map(tool => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        input_schema: tool.input_schema,
        source: 'builtin',
        risk: 'low',
        requiresApproval: false,
        admin: Boolean(tool.admin)
    })).filter(tool => isAllowed(tool.name, 'builtin'));
    const mcpTools = listCachedMcpTools(null, user).map(tool => ({
        name: tool.fullName,
        title: tool.name,
        description: `[${tool.serverName}] ${tool.description || tool.name}`,
        input_schema: tool.input_schema,
        source: 'mcp',
        risk: String(tool.name || '').startsWith('db.') ? 'low' : 'high',
        requiresApproval: !String(tool.name || '').startsWith('db.'),
        serverName: tool.serverName
    })).filter(tool => isAllowed(tool.name, 'mcp'));
    return [...builtIns, ...mcpTools];
}

async function callModelJson(modelCfg, messages) {
    const response = await axios.post(buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: false }), {
        model: modelCfg.model_name || modelCfg.name,
        messages,
        stream: false,
        temperature: 0.2,
        max_tokens: 1200
    }, {
        headers: buildModelHeaders(modelCfg, { acceptJson: true }),
        timeout: 180000,
        proxy: false
    });
    return response.data?.choices?.[0]?.message?.content || response.data?.output_text || '';
}

async function callModelText(modelCfg, messages) {
    try {
        return await callModelJson(modelCfg, messages);
    } catch (e) {
        if (!e.response || e.response.status < 400) throw e;
        throw e;
    }
}

function recordAgentModelUsage(user, modelCfg, messages, output, source = 'agent', runId = '') {
    const inputTokens = estimateTokens(JSON.stringify(messages || []));
    const outputTokens = estimateTokens(output || '');
    recordModelTokenUsage(user.id, modelCfg.id, inputTokens + outputTokens, source, inputTokens, outputTokens);
    if (runId) {
        db.prepare(`
            UPDATE agent_runs
            SET input_tokens = COALESCE(input_tokens, 0) + ?,
                output_tokens = COALESCE(output_tokens, 0) + ?,
                total_tokens = COALESCE(total_tokens, 0) + ?,
                last_heartbeat_at = ?,
                updated_at = ?
            WHERE id = ?
        `).run(inputTokens, outputTokens, inputTokens + outputTokens, getBeijingTimestamp(), getBeijingTimestamp(), runId);
        const run = db.prepare('SELECT max_token_budget, total_tokens FROM agent_runs WHERE id = ?').get(runId);
        if (run && Number(run.max_token_budget || 0) > 0 && Number(run.total_tokens || 0) > Number(run.max_token_budget || 0)) {
            const err = new Error(`智能体任务已超过 Token 预算 ${run.max_token_budget}`);
            err.code = 'AGENT_BUDGET_EXCEEDED';
            throw err;
        }
    }
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function buildPlannerMessages(goal, toolList, observations, runMode = 'standard', contextConfig = {}) {
    const context = normalizeContextConfig(contextConfig);
    const contextLines = [];
    if (context.mode === 'recent') contextLines.push('优先参考当前会话与最近会话上下文。');
    if (context.mode === 'knowledge') contextLines.push('优先使用知识库检索工具验证资料来源。');
    if (context.mode === 'none') contextLines.push('除用户目标外，不主动扩展额外上下文。');
    if (context.notes) contextLines.push(`用户补充上下文：${context.notes}`);
    return [
        {
            role: 'system',
            content: [
                '你是 Pivot 智能体运行时，负责为私有企业 AI 平台决定下一步动作。',
                '只能返回严格 JSON，不要返回 Markdown。',
                'Schema: {"thought":"short reasoning","action":"tool|final","tool":"tool.name","input":{},"answer":"final answer"}',
                `运行模式：${normalizeRunMode(runMode)}。standard 注重稳健，deep 可多轮检索，audit 为审查模式，必须强调证据、限制和风险。`,
                '只能调用下方可用工具清单中的工具，不能臆造工具名；没有合适工具时直接 final。',
                '当需要项目内最新数据时使用工具；证据足够后给出中文最终答案。',
                contextLines.length ? `上下文策略：${contextLines.join(' ')}` : '上下文策略：自动选择与目标相关的安全上下文。',
                '可用工具：',
                JSON.stringify(toolList, null, 2)
            ].join('\n')
        },
        {
            role: 'user',
            content: [
                `目标：${goal}`,
                '已有观察：',
                observations.length ? JSON.stringify(observations, null, 2) : '[]'
            ].join('\n\n')
        }
    ];
}

async function executeToolByName(name, input, user, toolList = []) {
    const safeName = String(name || '').trim();
    const tool = toolList.find(item => item.name === safeName);
    if (!tool) {
        const err = new Error(`工具未授权或不可用：${safeName || '-'}`);
        err.status = 403;
        throw err;
    }
    if (safeName.startsWith('mcp.')) {
        return executeMcpTool(safeName, input, user);
    }
    return executeBuiltInTool(safeName, input, user);
}

function isApprovalGranted(run, toolName) {
    const metadata = getRunMetadata(run);
    const approved = Array.isArray(metadata.approvedTools) ? metadata.approvedTools : [];
    return approved.includes(toolName) || metadata.approval === 'all_mcp_approved';
}

function maybePauseForApproval(run, tool, input) {
    if (!tool || !tool.requiresApproval) return false;
    if (normalizeApprovalPolicy(run.approval_policy) !== 'approve_all_mcp') return false;
    if (isApprovalGranted(run, tool.name)) return false;
    const now = getBeijingTimestamp();
    setRunMetadata(run.id, {
        pendingApproval: {
            tool: tool.name,
            title: tool.title || tool.name,
            requestedAt: now,
            input
        }
    });
    updateRun(run.id, {
        status: 'approval_required',
        error_message: `等待用户审批 MCP 工具：${tool.title || tool.name}`,
        updated_at: now,
        last_heartbeat_at: now
    });
    insertStep(run.id, listSteps(run.id).length + 1, {
        type: 'approval',
        title: `等待审批：${tool.title || tool.name}`,
        toolName: tool.name,
        input,
        output: { status: 'approval_required', tool: tool.name }
    });
    createAgentNotification(run.user_id, run.id, 'approval', '智能体等待 MCP 审批', tool.title || tool.name);
    return true;
}

async function synthesizeFinalAnswer(modelCfg, goal, observations, user = null, runId = '') {
    const messages = [
        {
            role: 'system',
            content: '请用简洁中文为用户总结智能体工作，包含有用发现、已执行动作、错误和下一步建议。'
        },
        {
            role: 'user',
            content: `目标：${goal}\n\n执行记录：\n${JSON.stringify(observations, null, 2)}`
        }
    ];
    const content = await callModelText(modelCfg, messages);
    if (user) recordAgentModelUsage(user, modelCfg, messages, content, 'agent_summary', runId);
    return content || '任务已完成，但模型没有返回总结。';
}

async function runAgent(runId, user) {
    try {
        const run = getRunForUser(runId, user, { includeDeleted: true });
        if (!run) throw new Error('智能体任务不存在。');
        if (run.deleted_at) return;
        assertRunNotCancelled(runId);
        const deadline = Date.now() + normalizePositiveInt(run.timeout_ms, AGENT_DEFAULT_TIMEOUT_MS, 60000, 24 * 60 * 60 * 1000);
        const assertRunWithinBudget = () => {
            if (Date.now() > deadline) {
                const err = new Error('智能体任务运行超时。');
                err.code = 'AGENT_TIMEOUT';
                throw err;
            }
        };
        const modelCfg = getRunnableModelForUser(run.model_id, user);
        if (!modelCfg) throw new Error('当前智能体任务没有可用模型。');

        const observations = [];
        const toolList = formatToolList(user, {
            toolPolicy: run.tool_policy,
            toolAllowlist: run.tool_allowlist
        });
        if (toolList.length === 0) {
            throw new Error('当前智能体没有可用工具，请调整工具范围后重试。');
        }
        assertRunNotCancelled(runId);
        const startedAt = getBeijingTimestamp();
        updateRun(runId, {
            status: 'running',
            started_at: run.started_at || startedAt,
            last_heartbeat_at: startedAt,
            updated_at: startedAt
        });

        for (let step = 1; step <= normalizeMaxSteps(run.max_steps); step += 1) {
            assertRunWithinBudget();
            assertRunNotCancelled(runId);
            updateRun(runId, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
            const plannerMessages = buildPlannerMessages(run.goal, toolList, observations, run.run_mode, parseJsonObject(run.context_config) || {});
            const plannedText = await withTimeout(callModelText(modelCfg, plannerMessages), Math.min(180000, Math.max(deadline - Date.now(), 1000)), '模型规划');
            recordAgentModelUsage(user, modelCfg, plannerMessages, plannedText, 'agent_planner', runId);
            assertRunWithinBudget();
            assertRunNotCancelled(runId);
            const plan = parseJsonObject(plannedText) || {};
            insertStep(runId, step, {
                type: 'plan',
                title: plan.thought || '规划下一步',
                input: { goal: run.goal },
                output: plan
            });

            if (plan.action === 'final' || !plan.tool) {
                const answer = plan.answer || await synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId);
                updateRun(runId, {
                    status: 'completed',
                    final_answer: answer,
                    completed_at: getBeijingTimestamp(),
                    last_heartbeat_at: getBeijingTimestamp(),
                    updated_at: getBeijingTimestamp()
                });
                createAgentNotification(user.id, runId, 'completed', '智能体任务已完成', run.title || run.goal);
                return;
            }

            const startedAt = Date.now();
            try {
                assertRunNotCancelled(runId);
                assertRunWithinBudget();
                updateRun(runId, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
                const selectedTool = toolList.find(tool => tool.name === plan.tool);
                if (maybePauseForApproval(run, selectedTool, plan.input || {})) return;
                const output = await withTimeout(
                    executeToolByName(plan.tool, plan.input || {}, user, toolList),
                    Math.min(normalizePositiveInt(run.tool_timeout_ms, AGENT_TOOL_TIMEOUT_MS, 30000, 10 * 60 * 1000), Math.max(deadline - Date.now(), 1000)),
                    `工具调用 ${plan.tool}`
                );
                assertRunNotCancelled(runId);
                assertRunWithinBudget();
                const compactOutput = clampText(output, 10000);
                observations.push({
                    step,
                    tool: plan.tool,
                    input: plan.input || {},
                    output: compactOutput
                });
                insertStep(runId, step, {
                    type: 'tool',
                    title: `调用工具：${plan.tool}`,
                    toolName: plan.tool,
                    input: plan.input || {},
                    output: compactOutput,
                    durationMs: Date.now() - startedAt
                });
            } catch (toolErr) {
                observations.push({
                    step,
                    tool: plan.tool,
                    input: plan.input || {},
                    error: toolErr.message
                });
                insertStep(runId, step, {
                    type: 'tool',
                    title: `工具调用失败：${plan.tool}`,
                    toolName: plan.tool,
                    input: plan.input || {},
                    output: { error: toolErr.message },
                    errorMessage: toolErr.message,
                    status: 'error',
                    durationMs: Date.now() - startedAt
                });
            }
        }

        assertRunNotCancelled(runId);
        assertRunWithinBudget();
        const answer = await withTimeout(synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId), Math.min(180000, Math.max(deadline - Date.now(), 1000)), '结果总结');
        assertRunNotCancelled(runId);
        updateRun(runId, {
            status: 'completed',
            final_answer: answer,
            completed_at: getBeijingTimestamp(),
            last_heartbeat_at: getBeijingTimestamp(),
            updated_at: getBeijingTimestamp()
        });
        createAgentNotification(user.id, runId, 'completed', '智能体任务已完成', run.title || run.goal);
    } catch (e) {
        if (e.code === 'AGENT_RUN_CANCELLED') {
            updateRun(runId, { updated_at: getBeijingTimestamp() });
            return;
        }
        logger.error({ err: e.message, runId }, 'Agent run failed');
        const retryLimit = normalizePositiveInt(db.prepare('SELECT retry_limit FROM agent_runs WHERE id = ?').get(runId)?.retry_limit, 0, 0, 5);
        const retryCount = normalizePositiveInt(db.prepare('SELECT retry_count FROM agent_runs WHERE id = ?').get(runId)?.retry_count, 0, 0, 99);
        if (retryCount < retryLimit && e.code !== 'AGENT_BUDGET_EXCEEDED' && e.code !== 'AGENT_TIMEOUT') {
            updateRun(runId, {
                status: 'queued',
                error_message: e.message,
                retry_count: retryCount + 1,
                updated_at: getBeijingTimestamp()
            });
            insertStep(runId, listSteps(runId).length + 1, {
                type: 'control',
                title: `自动重试 ${retryCount + 1}/${retryLimit}`,
                output: { error: e.message }
            });
            enqueueAgentRun(runId, user);
            return;
        }
        updateRun(runId, {
            status: 'error',
            error_message: e.message,
            completed_at: getBeijingTimestamp(),
            last_heartbeat_at: getBeijingTimestamp(),
            updated_at: getBeijingTimestamp()
        });
        createAgentNotification(user.id, runId, 'error', '智能体任务失败', e.message);
    }
}

function processAgentQueue() {
    while (activeAgentRuns.size < AGENT_MAX_CONCURRENT_RUNS && pendingAgentQueue.length > 0) {
        const next = pendingAgentQueue.shift();
        if (!next || activeAgentRuns.has(next.runId)) continue;
        if (getRunStatus(next.runId) !== 'queued') continue;
        activeAgentRuns.add(next.runId);
        runAgent(next.runId, next.user).catch(err => {
            logger.error({ err: err.message, runId: next.runId }, 'Agent run failed outside runtime guard');
            updateRun(next.runId, {
                status: 'error',
                error_message: err.message,
                completed_at: getBeijingTimestamp(),
                last_heartbeat_at: getBeijingTimestamp(),
                updated_at: getBeijingTimestamp()
            });
        }).finally(() => {
            activeAgentRuns.delete(next.runId);
            processAgentQueue();
        });
    }
}

function enqueueAgentRun(runId, user) {
    if (!pendingAgentQueue.some(item => item.runId === runId) && !activeAgentRuns.has(runId)) {
        pendingAgentQueue.push({ runId, user, enqueuedAt: Date.now() });
        pendingAgentQueue.sort((a, b) => {
            const left = db.prepare('SELECT priority, created_at FROM agent_runs WHERE id = ?').get(a.runId) || {};
            const right = db.prepare('SELECT priority, created_at FROM agent_runs WHERE id = ?').get(b.runId) || {};
            return (Number(right.priority || 0) - Number(left.priority || 0))
                || String(left.created_at || '').localeCompare(String(right.created_at || ''));
        });
    }
    setImmediate(processAgentQueue);
}

function recoverAgentRuns() {
    const now = getBeijingTimestamp();
    const staleRunning = db.prepare(`
        SELECT id FROM agent_runs
        WHERE status = 'running'
          AND deleted_at IS NULL
          AND (last_heartbeat_at IS NULL OR last_heartbeat_at < datetime('now', '+8 hours', ?))
    `).all(`-${AGENT_STALE_RUNNING_MINUTES} minutes`);
    staleRunning.forEach(run => {
        updateRun(run.id, {
            status: 'error',
            error_message: '服务重启或心跳超时，任务已标记为异常。',
            completed_at: now,
            updated_at: now,
            last_heartbeat_at: now
        });
        insertStep(run.id, listSteps(run.id).length + 1, {
            type: 'control',
            title: '运行恢复标记异常',
            output: { status: 'error', reason: 'stale_running' }
        });
    });

    const queued = db.prepare(`
        SELECT id FROM agent_runs
        WHERE status = 'queued' AND deleted_at IS NULL
        ORDER BY priority DESC, created_at ASC
        LIMIT 100
    `).all();
    queued.forEach(run => {
        const user = getRunUser(run.id);
        if (user) enqueueAgentRun(run.id, user);
    });
    logger.info({ recoveredQueued: queued.length, staleRunning: staleRunning.length }, 'Agent runtime recovery completed');
}

function approveAgentTool(runId, user, approve = true) {
    const run = getRunForUser(runId, user);
    if (!run) return null;
    if (run.status !== 'approval_required') return run;
    const metadata = getRunMetadata(run);
    const pending = metadata.pendingApproval || {};
    const now = getBeijingTimestamp();
    if (!approve) {
        updateRun(runId, {
            status: 'cancelled',
            error_message: `用户拒绝 MCP 工具审批：${pending.tool || '-'}`,
            cancelled_at: now,
            completed_at: now,
            updated_at: now
        });
        setRunMetadata(runId, { pendingApproval: null });
        insertStep(runId, listSteps(runId).length + 1, {
            type: 'approval',
            title: '用户拒绝工具审批',
            toolName: pending.tool || '',
            output: { status: 'rejected' }
        });
        createAgentNotification(user.id, runId, 'cancelled', '智能体审批已拒绝', pending.tool || run.title || run.goal);
        return getRunForUser(runId, user);
    }
    const approvedTools = new Set(Array.isArray(metadata.approvedTools) ? metadata.approvedTools : []);
    if (pending.tool) approvedTools.add(pending.tool);
    setRunMetadata(runId, { pendingApproval: null, approvedTools: [...approvedTools] });
    updateRun(runId, { status: 'queued', error_message: '', updated_at: now });
    insertStep(runId, listSteps(runId).length + 1, {
        type: 'approval',
        title: '用户批准工具调用',
        toolName: pending.tool || '',
        output: { status: 'approved', tool: pending.tool || '' }
    });
    enqueueAgentRun(runId, user);
    return getRunForUser(runId, user);
}

function getAgentRuntimeStatus(user = null) {
    const queuedTotal = db.prepare(`
        SELECT COUNT(*) AS count FROM agent_runs
        WHERE status = 'queued' AND deleted_at IS NULL
    `).get().count || 0;
    const userQueued = user?.id ? db.prepare(`
        SELECT COUNT(*) AS count FROM agent_runs
        WHERE status = 'queued' AND deleted_at IS NULL AND user_id = ?
    `).get(user.id).count || 0 : 0;
    return {
        maxConcurrent: AGENT_MAX_CONCURRENT_RUNS,
        active: activeAgentRuns.size,
        queued: pendingAgentQueue.length,
        databaseQueued: queuedTotal,
        userQueued
    };
}

function getAgentMetrics(user, days = 7) {
    const safeDays = normalizePositiveInt(days, 7, 1, 90);
    const params = [user.id, `-${safeDays} days`];
    const baseWhere = user?.username === 'admin'
        ? "created_at >= datetime('now', '+8 hours', ?)"
        : "user_id = ? AND created_at >= datetime('now', '+8 hours', ?)";
    const actualParams = user?.username === 'admin' ? [`-${safeDays} days`] : params;
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

function assertTemplateAccess(template, user, write = false) {
    if (!template || template.deleted_at) return false;
    if (template.user_id === user.id) return true;
    if (write) return false;
    if (template.scope !== 'shared') return false;
    const allowedUnits = String(template.allowed_units || '').split(',').map(item => item.trim()).filter(Boolean);
    return allowedUnits.length === 0 || allowedUnits.includes(user.unit || '');
}

function normalizeTemplatePayload(body = {}, user = {}) {
    const name = String(body.name || '').trim().slice(0, 80);
    const goalTemplate = String(body.goalTemplate || body.goal_template || body.goal || '').trim();
    if (!name || goalTemplate.length < 4) {
        const err = new Error('请填写模板名称和明确的任务目标。');
        err.status = 400;
        throw err;
    }
    const shared = body.scope === 'shared' && user?.role === 'admin';
    return {
        name,
        scope: shared ? 'shared' : 'personal',
        description: String(body.description || '').trim().slice(0, 300),
        goalTemplate: goalTemplate.slice(0, MAX_GOAL_LENGTH),
        runMode: normalizeRunMode(body.runMode || body.run_mode),
        toolPolicy: normalizeToolPolicy(body.toolPolicy || body.tool_policy),
        toolAllowlist: serializeToolAllowlist(body.toolAllowlist || body.tool_allowlist),
        approvalPolicy: normalizeApprovalPolicy(body.approvalPolicy || body.approval_policy),
        maxSteps: normalizeMaxSteps(body.maxSteps || body.max_steps),
        maxTokenBudget: normalizePositiveInt(body.maxTokenBudget || body.max_token_budget, 0, 0, 10000000),
        retryLimit: normalizePositiveInt(body.retryLimit || body.retry_limit, 1, 0, 5),
        contextConfig: serializeContextConfig(body.contextConfig || body.context_config),
        allowedUnits: shared ? String(body.allowedUnits || body.allowed_units || '').trim().slice(0, 500) : ''
    };
}

function listAgentTemplates(user) {
    return db.prepare(`
        SELECT *
        FROM agent_templates
        WHERE deleted_at IS NULL
          AND (user_id = ? OR scope = 'shared')
        ORDER BY scope DESC, updated_at DESC, id DESC
        LIMIT 100
    `).all(user.id).filter(template => assertTemplateAccess(template, user, false));
}

function createAgentTemplate(user, body = {}) {
    const data = normalizeTemplatePayload(body, user);
    const now = getBeijingTimestamp();
    const info = db.prepare(`
        INSERT INTO agent_templates (
            user_id, scope, name, description, goal_template, run_mode, tool_policy, tool_allowlist,
            approval_policy, max_steps, max_token_budget, retry_limit, context_config, allowed_units,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        user.id, data.scope, data.name, data.description, data.goalTemplate, data.runMode,
        data.toolPolicy, data.toolAllowlist, data.approvalPolicy, data.maxSteps,
        data.maxTokenBudget, data.retryLimit, data.contextConfig, data.allowedUnits, now, now
    );
    return db.prepare('SELECT * FROM agent_templates WHERE id = ?').get(info.lastInsertRowid);
}

function updateAgentTemplate(templateId, user, body = {}) {
    const template = db.prepare('SELECT * FROM agent_templates WHERE id = ?').get(templateId);
    if (!assertTemplateAccess(template, user, true)) return null;
    const data = normalizeTemplatePayload(body, user);
    db.prepare(`
        UPDATE agent_templates
        SET scope = ?, name = ?, description = ?, goal_template = ?, run_mode = ?, tool_policy = ?,
            tool_allowlist = ?, approval_policy = ?, max_steps = ?, max_token_budget = ?, retry_limit = ?,
            context_config = ?, allowed_units = ?, updated_at = ?
        WHERE id = ?
    `).run(
        data.scope, data.name, data.description, data.goalTemplate, data.runMode, data.toolPolicy,
        data.toolAllowlist, data.approvalPolicy, data.maxSteps, data.maxTokenBudget, data.retryLimit,
        data.contextConfig, data.allowedUnits, getBeijingTimestamp(), templateId
    );
    return db.prepare('SELECT * FROM agent_templates WHERE id = ?').get(templateId);
}

function deleteAgentTemplate(templateId, user) {
    const template = db.prepare('SELECT * FROM agent_templates WHERE id = ?').get(templateId);
    if (!assertTemplateAccess(template, user, true)) return null;
    const now = getBeijingTimestamp();
    db.prepare('UPDATE agent_templates SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, templateId);
    return { ...template, deleted_at: now };
}

function parseBeijingDate(value) {
    const text = String(value || '').replace(' ', 'T');
    const date = text ? new Date(text) : new Date();
    return Number.isNaN(date.getTime()) ? new Date() : date;
}

function toBeijingTimestamp(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function computeNextScheduleRun(frequency, timeOfDay = '09:00', dayOfWeek = 1, from = getBeijingTimestamp()) {
    const normalized = normalizeScheduleFrequency(frequency);
    if (normalized === 'manual') return null;
    const match = String(timeOfDay || '09:00').match(/^(\d{1,2}):(\d{2})$/);
    const hour = Math.min(Number(match?.[1] || 9), 23);
    const minute = Math.min(Number(match?.[2] || 0), 59);
    const base = parseBeijingDate(from);
    const candidate = new Date(base);
    candidate.setHours(hour, minute, 0, 0);
    if (normalized === 'daily') {
        if (candidate <= base) candidate.setDate(candidate.getDate() + 1);
        return toBeijingTimestamp(candidate);
    }
    const targetDay = Math.max(0, Math.min(Number.parseInt(dayOfWeek, 10) || 1, 6));
    let diff = (targetDay - candidate.getDay() + 7) % 7;
    if (diff === 0 && candidate <= base) diff = 7;
    candidate.setDate(candidate.getDate() + diff);
    return toBeijingTimestamp(candidate);
}

function normalizeSchedulePayload(body = {}) {
    const name = String(body.name || '').trim().slice(0, 100);
    const goal = String(body.goal || '').trim();
    const frequency = normalizeScheduleFrequency(body.frequency);
    if (!name || goal.length < 4) {
        const err = new Error('请填写计划名称和明确的任务目标。');
        err.status = 400;
        throw err;
    }
    return {
        name,
        goal: goal.slice(0, MAX_GOAL_LENGTH),
        modelId: body.modelId || body.model_id,
        templateId: body.templateId || body.template_id || null,
        frequency,
        timeOfDay: String(body.timeOfDay || body.time_of_day || '09:00').slice(0, 5),
        dayOfWeek: normalizePositiveInt(body.dayOfWeek || body.day_of_week, 1, 0, 6),
        status: body.status === 'paused' ? 'paused' : 'active',
        runConfig: {
            maxSteps: normalizeMaxSteps(body.maxSteps || body.max_steps),
            runMode: normalizeRunMode(body.runMode || body.run_mode),
            toolPolicy: normalizeToolPolicy(body.toolPolicy || body.tool_policy),
            toolAllowlist: normalizeToolAllowlist(body.toolAllowlist || body.tool_allowlist),
            approvalPolicy: normalizeApprovalPolicy(body.approvalPolicy || body.approval_policy),
            retryLimit: normalizePositiveInt(body.retryLimit || body.retry_limit, 1, 0, 5),
            maxTokenBudget: normalizePositiveInt(body.maxTokenBudget || body.max_token_budget, 0, 0, 10000000),
            contextConfig: normalizeContextConfig(body.contextConfig || body.context_config)
        }
    };
}

function listAgentSchedules(user) {
    return db.prepare(`
        SELECT s.*, t.name AS template_name, m.name AS model_name
        FROM agent_schedules s
        LEFT JOIN agent_templates t ON t.id = s.template_id
        LEFT JOIN models m ON m.id = s.model_id
        WHERE s.user_id = ? AND s.deleted_at IS NULL
        ORDER BY s.status ASC, s.next_run_at ASC, s.updated_at DESC
        LIMIT 100
    `).all(user.id);
}

function createAgentSchedule(user, body = {}) {
    const data = normalizeSchedulePayload(body);
    const modelCfg = getRunnableModelForUser(data.modelId, user);
    if (!modelCfg) throw new Error('Please choose an accessible model for the schedule.');
    const now = getBeijingTimestamp();
    const info = db.prepare(`
        INSERT INTO agent_schedules (
            user_id, template_id, model_id, name, goal, frequency, time_of_day, day_of_week,
            status, run_config, next_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        user.id, data.templateId, modelCfg.id, data.name, data.goal, data.frequency,
        data.timeOfDay, data.dayOfWeek, data.status, JSON.stringify(data.runConfig),
        data.status === 'active' ? computeNextScheduleRun(data.frequency, data.timeOfDay, data.dayOfWeek, now) : null,
        now, now
    );
    return db.prepare('SELECT * FROM agent_schedules WHERE id = ?').get(info.lastInsertRowid);
}

function updateAgentSchedule(scheduleId, user, body = {}) {
    const schedule = db.prepare('SELECT * FROM agent_schedules WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(scheduleId, user.id);
    if (!schedule) return null;
    const data = normalizeSchedulePayload(body);
    const modelCfg = getRunnableModelForUser(data.modelId, user);
    if (!modelCfg) throw new Error('Please choose an accessible model for the schedule.');
    const now = getBeijingTimestamp();
    db.prepare(`
        UPDATE agent_schedules
        SET template_id = ?, model_id = ?, name = ?, goal = ?, frequency = ?, time_of_day = ?,
            day_of_week = ?, status = ?, run_config = ?, next_run_at = ?, updated_at = ?
        WHERE id = ?
    `).run(
        data.templateId, modelCfg.id, data.name, data.goal, data.frequency, data.timeOfDay,
        data.dayOfWeek, data.status, JSON.stringify(data.runConfig),
        data.status === 'active' ? computeNextScheduleRun(data.frequency, data.timeOfDay, data.dayOfWeek, now) : null,
        now, scheduleId
    );
    return db.prepare('SELECT * FROM agent_schedules WHERE id = ?').get(scheduleId);
}

function deleteAgentSchedule(scheduleId, user) {
    const schedule = db.prepare('SELECT * FROM agent_schedules WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(scheduleId, user.id);
    if (!schedule) return null;
    db.prepare('UPDATE agent_schedules SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(getBeijingTimestamp(), getBeijingTimestamp(), scheduleId);
    return schedule;
}

function runAgentScheduleNow(scheduleId, user) {
    const schedule = db.prepare('SELECT * FROM agent_schedules WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(scheduleId, user.id);
    if (!schedule) return null;
    const cfg = parseJsonObject(schedule.run_config) || {};
    const run = createAgentRun({
        user,
        goal: schedule.goal,
        modelId: schedule.model_id,
        title: schedule.name,
        maxSteps: cfg.maxSteps,
        runMode: cfg.runMode,
        toolPolicy: cfg.toolPolicy,
        toolAllowlist: cfg.toolAllowlist,
        approvalPolicy: cfg.approvalPolicy,
        retryLimit: cfg.retryLimit,
        maxTokenBudget: cfg.maxTokenBudget,
        templateId: schedule.template_id,
        scheduleId: schedule.id,
        contextConfig: cfg.contextConfig,
        priority: 1
    });
    db.prepare('UPDATE agent_schedules SET last_run_at = ?, last_run_id = ?, updated_at = ? WHERE id = ?')
        .run(getBeijingTimestamp(), run.id, getBeijingTimestamp(), schedule.id);
    return run;
}

function runDueAgentSchedules(limit = 20) {
    const due = db.prepare(`
        SELECT s.*, u.username, u.nickname, u.unit, u.role
        FROM agent_schedules s
        JOIN users u ON u.id = s.user_id
        WHERE s.status = 'active'
          AND s.deleted_at IS NULL
          AND s.next_run_at IS NOT NULL
          AND s.next_run_at <= datetime('now', '+8 hours')
        ORDER BY s.next_run_at ASC
        LIMIT ?
    `).all(normalizePositiveInt(limit, 20, 1, 100));
    const created = [];
    due.forEach(schedule => {
        const user = { id: schedule.user_id, username: schedule.username, nickname: schedule.nickname, unit: schedule.unit, role: schedule.role };
        try {
            const run = runAgentScheduleNow(schedule.id, user);
            const nextRunAt = computeNextScheduleRun(schedule.frequency, schedule.time_of_day, schedule.day_of_week, getBeijingTimestamp());
            db.prepare('UPDATE agent_schedules SET next_run_at = ?, last_run_id = ?, last_run_at = ?, updated_at = ? WHERE id = ?')
                .run(nextRunAt, run.id, getBeijingTimestamp(), getBeijingTimestamp(), schedule.id);
            createAgentNotification(user.id, run.id, 'schedule', '计划任务已入队', schedule.name);
            created.push(run);
        } catch (e) {
            logger.error({ err: e.message, scheduleId: schedule.id }, 'Agent schedule failed');
            db.prepare('UPDATE agent_schedules SET status = ?, updated_at = ? WHERE id = ?')
                .run('paused', getBeijingTimestamp(), schedule.id);
            createAgentNotification(user.id, null, 'error', '计划任务已暂停', `${schedule.name}: ${e.message}`);
        }
    });
    return created;
}

function startAgentScheduleRunner() {
    const tick = () => {
        try {
            runDueAgentSchedules();
        } catch (e) {
            logger.error({ err: e.message }, 'Agent schedule runner failed');
        }
    };
    const initial = setTimeout(tick, 5000);
    initial.unref?.();
    const timer = setInterval(tick, 60 * 1000);
    timer.unref?.();
    return timer;
}

function listAgentNotifications(user, limit = 20) {
    return db.prepare(`
        SELECT *
        FROM agent_notifications
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
    `).all(user.id, normalizePositiveInt(limit, 20, 1, 100));
}

function markAgentNotificationRead(notificationId, user) {
    const notification = db.prepare('SELECT * FROM agent_notifications WHERE id = ? AND user_id = ?').get(notificationId, user.id);
    if (!notification) return null;
    db.prepare("UPDATE agent_notifications SET status = 'read', read_at = ? WHERE id = ?")
        .run(getBeijingTimestamp(), notificationId);
    return db.prepare('SELECT * FROM agent_notifications WHERE id = ?').get(notificationId);
}

function listAgentArtifacts(user, limit = 30) {
    return db.prepare(`
        SELECT a.*, r.title AS run_title, r.status AS run_status
        FROM agent_artifacts a
        LEFT JOIN agent_runs r ON r.id = a.run_id
        WHERE a.user_id = ?
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ?
    `).all(user.id, normalizePositiveInt(limit, 30, 1, 100));
}

function saveAgentRunArtifact(runId, user, body = {}) {
    const detail = getRunDetailForUser(runId, user);
    if (!detail) return null;
    const content = String(body.content || detail.run.final_answer || detail.run.error_message || '').trim();
    if (!content) {
        const err = new Error('当前任务没有可沉淀的结果。');
        err.status = 400;
        throw err;
    }
    const title = String(body.title || detail.run.title || detail.run.goal || '智能体结果').trim().slice(0, 120);
    const info = db.prepare(`
        INSERT INTO agent_artifacts (run_id, user_id, type, title, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(runId, user.id, String(body.type || 'summary').slice(0, 40), title, content, getBeijingTimestamp());
    createAgentNotification(user.id, runId, 'artifact', '智能体结果已沉淀', title);
    return db.prepare('SELECT * FROM agent_artifacts WHERE id = ?').get(info.lastInsertRowid);
}

function exportAgentRun(runId, user, format = 'json') {
    const detail = getRunDetailForUser(runId, user);
    if (!detail) return null;
    const payload = {
        exportedAt: getBeijingTimestamp(),
        run: detail.run,
        progress: detail.progress,
        steps: detail.steps
    };
    db.prepare('UPDATE agent_runs SET export_count = COALESCE(export_count, 0) + 1, updated_at = ? WHERE id = ?')
        .run(getBeijingTimestamp(), runId);
    if (format === 'markdown') {
        const lines = [
            `# ${detail.run.title || '智能体任务报告'}`,
            '',
            `- 状态：${detail.run.status}`,
            `- 模型：${detail.run.model_name || detail.run.model_id || '-'}`,
            `- 运行模式：${detail.run.run_mode || 'standard'}`,
            `- 工具范围：${detail.run.tool_policy || 'all'}`,
            `- Token：${Number(detail.run.total_tokens || 0)}`,
            '',
            '## 目标',
            detail.run.goal || '',
            '',
            '## 最终结果',
            detail.run.final_answer || detail.run.error_message || '暂无最终结果',
            '',
            '## 执行步骤',
            ...detail.steps.map(step => [
                `### ${step.step_index}. ${step.title || step.type}`,
                `- 类型：${step.type}`,
                `- 工具：${step.tool_name || '-'}`,
                `- 状态：${step.status}`,
                step.error_message ? `- 错误：${step.error_message}` : '',
                '',
                '```json',
                JSON.stringify({ input: step.input, output: step.output }, null, 2),
                '```',
                ''
            ].join('\n'))
        ];
        return { contentType: 'text/markdown; charset=utf-8', filename: `${runId}.md`, body: lines.join('\n') };
    }
    return { contentType: 'application/json; charset=utf-8', filename: `${runId}.json`, body: JSON.stringify(payload, null, 2) };
}

function createAgentRun({
    user,
    goal,
    modelId,
    sessionId = null,
    title = '',
    maxSteps = DEFAULT_STEPS,
    parentRunId = null,
    priority = 0,
    runMode = 'standard',
    toolPolicy = 'all',
    toolAllowlist = [],
    approvalPolicy = 'safe_mcp_auto',
    timeoutMs = AGENT_DEFAULT_TIMEOUT_MS,
    toolTimeoutMs = AGENT_TOOL_TIMEOUT_MS,
    retryLimit = 1,
    maxTokenBudget = 0,
    templateId = null,
    scheduleId = null,
    contextConfig = {},
    resumeFromStep = 0,
    metadata = {}
}) {
    const cleanGoal = normalizeAgentGoal(goal);
    const modelCfg = getRunnableModelForUser(modelId, user);
    if (!modelCfg) throw new Error('Please choose an accessible model for the agent.');
    const runId = createRunId();
    const now = getBeijingTimestamp();
    const normalizedToolPolicy = normalizeToolPolicy(toolPolicy);
    const normalizedRunMode = normalizeRunMode(runMode);
    db.prepare(`
        INSERT INTO agent_runs (
            id, user_id, session_id, model_id, title, goal, status, max_steps, parent_run_id,
            priority, run_mode, tool_policy, tool_allowlist, approval_policy, timeout_ms, tool_timeout_ms,
            retry_limit, max_token_budget, template_id, schedule_id, context_config, resume_from_step,
            metadata, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        runId,
        user.id,
        sessionId || null,
        modelCfg.id,
        title || cleanGoal.slice(0, 40),
        cleanGoal,
        'queued',
        normalizeMaxSteps(maxSteps),
        parentRunId || null,
        normalizePriority(priority),
        normalizedRunMode,
        normalizedToolPolicy,
        serializeToolAllowlist(toolAllowlist),
        normalizeApprovalPolicy(approvalPolicy),
        normalizePositiveInt(timeoutMs, AGENT_DEFAULT_TIMEOUT_MS, 60000, 24 * 60 * 60 * 1000),
        normalizePositiveInt(toolTimeoutMs, AGENT_TOOL_TIMEOUT_MS, 30000, 10 * 60 * 1000),
        normalizePositiveInt(retryLimit, 1, 0, 5),
        normalizePositiveInt(maxTokenBudget, 0, 0, 10000000),
        templateId || null,
        scheduleId || null,
        serializeContextConfig(contextConfig),
        normalizePositiveInt(resumeFromStep, 0, 0, 999),
        JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {}),
        now,
        now
    );
    enqueueAgentRun(runId, user);
    return getRunForUser(runId, user);
}

module.exports = {
    createAgentRun,
    createAgentSchedule,
    createAgentTemplate,
    cancelAgentRun,
    computeNextScheduleRun,
    deleteAgentSchedule,
    deleteAgentTemplate,
    approveAgentTool,
    exportAgentRun,
    formatToolList,
    listAgentArtifacts,
    listAgentNotifications,
    listAgentSchedules,
    listAgentTemplates,
    getAgentMetrics,
    getAgentRuntimeStatus,
    getRunDetailForUser,
    getRunForUser,
    getRunProgress,
    listDeletedRunsForAdmin,
    listRuns,
    listSteps,
    normalizeAgentGoal,
    normalizeRunMode,
    normalizeApprovalPolicy,
    normalizeToolAllowlist,
    normalizeToolPolicy,
    parseJsonObject,
    rerunAgentRun,
    resumeAgentRun,
    recoverAgentRuns,
    runAgentScheduleNow,
    runDueAgentSchedules,
    runAgent,
    saveAgentRunArtifact,
    softDeleteAgentRun
    ,
    markAgentNotificationRead,
    startAgentScheduleRunner,
    updateAgentSchedule,
    updateAgentTemplate
};
