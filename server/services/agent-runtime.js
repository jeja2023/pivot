const crypto = require('crypto');
const { db } = require('../db');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { getRunnableModelForUser } = require('./models');
const { clampText, executeBuiltInTool } = require('./agent-tools');
const { executeMcpTool } = require('./mcp-client');
const { createAgentQueue } = require('./agent-queue');
const { callModelText, recordAgentModelUsage, callModelStreamingWithTools } = require('./agent-model');
const { publishUserEvent } = require('./realtime-events');
const { chooseModel, normalizeStrategy: normalizeRouterStrategy, assessConfidence, pickEscalationModel } = require('./model-router');
const { getModelEndpointRuntimeStatus } = require('./model-runtime');
const {
    configureAgentSchedules,
    computeNextScheduleRun,
    createAgentSchedule,
    deleteAgentSchedule,
    listAgentSchedules,
    runAgentScheduleNow,
    runDueAgentSchedules,
    startAgentScheduleRunner,
    updateAgentSchedule
} = require('./agent-schedules');
const {
    createAgentTemplate,
    deleteAgentTemplate,
    listAgentTemplates,
    updateAgentTemplate
} = require('./agent-templates');
const {
    createAgentWorkflow,
    deleteAgentWorkflow,
    diffAgentWorkflowVersions,
    getAgentWorkflowForUser,
    listAgentWorkflowVersions,
    listAgentWorkflows,
    normalizeDagInputsPayload,
    normalizeDagRunInputs,
    publishAgentWorkflowVersion,
    restoreAgentWorkflow,
    resolveAgentWorkflowVersion,
    restoreAgentWorkflowVersion,
    updateAgentWorkflow
} = require('./agent-workflows');
const {
    getRunDetailForUser: getRunDetailForUserHelper,
    getRunForUser,
    listDagNodes,
    listSteps
} = require('./agent-runs');
const {
    configureAgentArtifacts,
    createAgentArtifactVersion,
    diffAgentArtifactVersions,
    exportAgentRun,
    getAgentArtifactForUser,
    listAgentArtifactVersions,
    listAgentArtifacts,
    listAgentNotifications,
    markAgentNotificationRead,
    rollbackAgentArtifactVersion,
    saveAgentRunArtifact
} = require('./agent-artifacts');
const {
    normalizeDagNodePolicy,
    resolveDagNodeInput
} = require('./agent-dag-utils');
const {
    buildAgentToolSchemas,
    formatToolList
} = require('./agent-tool-catalog');
const {
    getAgentMetrics,
    getAgentRuntimeStatus: buildAgentRuntimeStatus
} = require('./agent-monitoring');
const { buildAssistantToolMessage, buildToolResultMessage } = require('./streaming-tools');
const {
    DEFAULT_STEPS,
    ACTIVE_STATUSES,
    parseJsonObject,
    normalizeMaxSteps,
    normalizePriority,
    normalizeRunMode,
    normalizeToolPolicy,
    normalizeApprovalPolicy,
    normalizePositiveInt,
    normalizeContextConfig,
    serializeContextConfig,
    normalizeDagSpec,
    normalizeToolAllowlist,
    serializeToolAllowlist,
    normalizeAgentGoal,
    looksLikeCorruptTitle,
    normalizeAgentTitle
} = require('./agent-validators');

const AGENT_MAX_CONCURRENT_RUNS = Math.max(Number.parseInt(process.env.AGENT_MAX_CONCURRENT_RUNS || '2', 10) || 2, 1);
const AGENT_DEFAULT_TIMEOUT_MS = Math.max(Number.parseInt(process.env.AGENT_RUN_TIMEOUT_MS || '600000', 10) || 600000, 60000);
const AGENT_TOOL_TIMEOUT_MS = Math.max(Number.parseInt(process.env.AGENT_TOOL_TIMEOUT_MS || '120000', 10) || 120000, 30000);
const AGENT_STALE_RUNNING_MINUTES = Math.max(Number.parseInt(process.env.AGENT_STALE_RUNNING_MINUTES || '30', 10) || 30, 5);
const AGENT_QUEUE_LOCK_MS = Math.max(Number.parseInt(process.env.AGENT_QUEUE_LOCK_MS || `${24 * 60 * 60 * 1000}`, 10) || (24 * 60 * 60 * 1000), 60000);
const AGENT_DAG_NODE_CONCURRENCY = Math.max(Number.parseInt(process.env.AGENT_DAG_NODE_CONCURRENCY || '4', 10) || 4, 1);
const AGENT_INSTANCE_ID = process.env.PIVOT_INSTANCE_ID || `agent_${crypto.randomBytes(4).toString('hex')}`;
let agentQueue = null;

function createRunId() {
    return `run_${crypto.randomBytes(12).toString('hex')}`;
}

function withTimeout(promise, timeoutMs, label = 'operation') {
    const safeTimeout = Math.max(Number(timeoutMs) || 0, 1000);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const err = new Error(`${label} timed out`);
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

function getAgentRunTitle(run) {
    return normalizeAgentTitle(run?.title, run?.goal);
}

function updateRun(runId, fields = {}) {
    const allowed = [
        'status', 'final_answer', 'error_message', 'completed_at', 'updated_at', 'title',
        'cancelled_at', 'deleted_at', 'deleted_by_user', 'delete_reason', 'started_at',
        'last_heartbeat_at', 'priority', 'run_mode', 'tool_policy', 'tool_allowlist',
        'approval_policy', 'timeout_ms', 'tool_timeout_ms', 'retry_limit', 'retry_count',
        'max_token_budget', 'export_count', 'template_id', 'schedule_id', 'context_config',
        'resume_from_step', 'metadata', 'locked_by', 'lock_expires_at',
        'input_tokens', 'output_tokens', 'total_tokens'
    ];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    if (entries.length === 0) return;
    const set = entries.map(([key]) => `${key} = ?`).join(', ');
    const info = db.prepare(`UPDATE agent_runs SET ${set} WHERE id = ?`).run(...entries.map(([, value]) => value), runId);
    if (info.changes > 0 && entries.some(([key]) => [
        'status',
        'final_answer',
        'error_message',
        'completed_at',
        'cancelled_at',
        'deleted_at',
        'last_heartbeat_at'
    ].includes(key))) {
        publishAgentRunEvent(runId, 'updated');
    }
}

function publishAgentRunEvent(runId, reason = 'updated', extra = {}) {
    const run = db.prepare(`
        SELECT id, user_id, title, goal, status, updated_at, started_at, completed_at, last_heartbeat_at, error_message
        FROM agent_runs
        WHERE id = ?
    `).get(runId);
    if (!run) return 0;
    return publishUserEvent(run.user_id, 'agent.run', {
        reason,
        run: {
            id: run.id,
            title: getAgentRunTitle(run),
            goal: run.goal,
            status: run.status,
            updated_at: run.updated_at,
            started_at: run.started_at,
            completed_at: run.completed_at,
            last_heartbeat_at: run.last_heartbeat_at,
            error_message: run.error_message
        },
        ...extra
    });
}

function getRunStatus(runId) {
    return db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId)?.status || '';
}

function getRunUser(runId) {
    return db.prepare('SELECT u.id, u.username, u.nickname, u.unit, u.role FROM agent_runs r JOIN users u ON u.id = r.user_id WHERE r.id = ?').get(runId);
}

function markRunError(runId, message) {
    updateRun(runId, {
        status: 'error',
        error_message: message,
        completed_at: getBeijingTimestamp(),
        last_heartbeat_at: getBeijingTimestamp(),
        updated_at: getBeijingTimestamp()
    });
}

function getAgentQueue() {
    if (!agentQueue) {
        agentQueue = createAgentQueue({
            db,
            logger,
            instanceId: AGENT_INSTANCE_ID,
            maxConcurrent: AGENT_MAX_CONCURRENT_RUNS,
            lockMs: AGENT_QUEUE_LOCK_MS,
            getRunUser,
            runAgent,
            markRunError,
            getTimestamp: getBeijingTimestamp
        });
    }
    return agentQueue;
}

function getRunMetadata(run) {
    const parsed = parseJsonObject(run?.metadata);
    return parsed && typeof parsed === 'object' ? parsed : {};
}

function createAgentNotification(userId, runId, type, title, body = '') {
    if (!userId || !title) return null;
    const run = runId
        ? db.prepare('SELECT title, goal FROM agent_runs WHERE id = ?').get(runId)
        : null;
    const fallbackTitle = run ? getAgentRunTitle(run) : '智能体通知';
    const safeTitle = looksLikeCorruptTitle(title) ? fallbackTitle : String(title || '').trim();
    const safeBody = looksLikeCorruptTitle(body) ? fallbackTitle : String(body || '').trim();
    const info = db.prepare(`
        INSERT INTO agent_notifications (user_id, run_id, type, title, body, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'unread', ?)
    `).run(
        userId,
        runId || null,
        String(type || 'info').slice(0, 40),
        safeTitle.slice(0, 160),
        safeBody.slice(0, 1000),
        getBeijingTimestamp()
    );
    const notification = db.prepare('SELECT * FROM agent_notifications WHERE id = ?').get(info.lastInsertRowid);
    publishUserEvent(userId, 'agent.notification', { notification });
    return notification;
}

function setRunMetadata(runId, patch = {}) {
    const row = db.prepare('SELECT metadata FROM agent_runs WHERE id = ?').get(runId) || {};
    const current = parseJsonObject(row.metadata) || {};
    updateRun(runId, { metadata: JSON.stringify({ ...current, ...patch }), updated_at: getBeijingTimestamp() });
}

function isRunCancelled(runId) {
    return getRunStatus(runId) === 'cancelled';
}

function assertRunNotCancelled(runId) {
    if (isRunCancelled(runId)) {
        const err = new Error('Agent run has been cancelled.');
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
        error_message: 'Run cancelled by user.',
        cancelled_at: now,
        completed_at: now,
        updated_at: now
    });
    insertStep(runId, listSteps(runId).length + 1, {
        type: 'control',
        title: 'User cancelled run',
        output: { status: 'cancelled' }
    });
    createAgentNotification(user.id, runId, 'cancelled', 'Agent run cancelled', getAgentRunTitle(run));
    return getRunForUser(runId, user);
}

function createChildRunFromExisting(run, user) {
    const metadata = getRunMetadata(run);
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
        parentRunId: run.id,
        metadata,
        dagSpec: metadata.dagSpec
    });
}

function rerunAgentRun(runId, user) {
    const run = getRunForUser(runId, user);
    if (!run) return null;
    if (ACTIVE_STATUSES.has(run.status)) {
        const err = new Error('当前任务仍在执行中，请停止或等待结束后再重新运行。');
        err.status = 400;
        throw err;
    }
    return createChildRunFromExisting(run, user);
}

function buildDagResumeSpec(originalRun, startNodeId = '') {
    const metadata = getRunMetadata(originalRun);
    const dagSpec = normalizeDagSpec(metadata.dagSpec || metadata.dag || {});
    if (!dagSpec.nodes.length) return null;
    const dagNodes = listDagNodes(originalRun.id);
    const failed = dagNodes.filter(node => node.status === 'error');
    const startIds = startNodeId
        ? [String(startNodeId)]
        : failed.map(node => node.node_key);
    const validStartIds = startIds.filter(id => dagSpec.nodes.some(node => node.id === id));
    if (!validStartIds.length) return null;
    const include = new Set(validStartIds);
    let changed = true;
    while (changed) {
        changed = false;
        dagSpec.nodes.forEach(node => {
            if (include.has(node.id)) return;
            if ((node.dependsOn || []).some(dep => include.has(dep))) {
                include.add(node.id);
                changed = true;
            }
        });
    }
    const reusable = {};
    dagNodes.forEach(node => {
        if (include.has(node.node_key)) return;
        if (node.status !== 'completed') return;
        reusable[node.node_key] = {
            status: node.status,
            input: node.input,
            output: node.output,
            reusedFromRunId: originalRun.id
        };
    });
    const nodes = dagSpec.nodes.filter(node => include.has(node.id)).map(node => ({
        ...node,
        dependsOn: (node.dependsOn || []).filter(dep => include.has(dep))
    }));
    return { dagSpec: { nodes }, reusable };
}

function rerunAgentDagFromNode(runId, user, nodeId = '') {
    const run = getRunForUser(runId, user);
    if (!run) return null;
    if (ACTIVE_STATUSES.has(run.status)) {
        const err = new Error('当前任务仍在执行中，请停止或等待结束后再重跑节点。');
        err.status = 400;
        throw err;
    }
    if (run.run_mode !== 'dag') {
        const err = new Error('Only DAG runs can be rerun from a node.');
        err.status = 400;
        throw err;
    }
    const resume = buildDagResumeSpec(run, nodeId);
    if (!resume || !resume.dagSpec.nodes.length) {
        const err = new Error('No reusable DAG node was found for rerun.');
        err.status = 400;
        throw err;
    }
    const metadata = getRunMetadata(run);
    return createAgentRun({
        user,
        goal: run.goal,
        modelId: run.model_id,
        sessionId: run.session_id,
        title: `重跑节点：${getAgentRunTitle(run)}`.slice(0, 80),
        maxSteps: run.max_steps,
        priority: run.priority,
        runMode: 'dag',
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
        parentRunId: run.id,
        metadata: {
            ...metadata,
            dagSpec: resume.dagSpec,
            reusedDagNodes: resume.reusable,
            rerunFromRunId: run.id,
            rerunFromNodeId: nodeId || '',
            workflowVersionMode: metadata.workflowVersionMode || ''
        },
        dagSpec: resume.dagSpec
    });
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
        'Continue this task from the previous run context.',
        `Previous status: ${run.status}`,
        run.final_answer ? `Previous answer: ${clampText(run.final_answer, 1200)}` : '',
        run.error_message ? `Previous error: ${run.error_message}` : '',
        failed.length ? `Recent failed steps: ${JSON.stringify(failed.map(step => ({ step: step.step_index, tool: step.tool_name, error: step.error_message })))}` : ''
    ].filter(Boolean).join('\n');
    const previousMetadata = getRunMetadata(run);
    return createAgentRun({
        user,
        goal: resumeGoal,
        modelId: run.model_id,
        sessionId: run.session_id,
        title: `断点续跑：${getAgentRunTitle(run)}`.slice(0, 80),
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
        metadata: {
            ...previousMetadata,
            pendingApproval: null,
            resumedFromRunId: run.id,
            failedSteps: failed.map(step => step.id)
        }
    });
}

function softDeleteAgentRun(runId, user, reason = '') {
    const run = getRunForUser(runId, user);
    if (!run) return null;
    if (ACTIVE_STATUSES.has(run.status)) {
        const err = new Error('Active agent runs cannot be deleted.');
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
        title: '任务记录已移除',
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
    const info = db.prepare(`
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
    if (info.changes > 0) {
        publishAgentRunEvent(runId, 'step', {
            step: {
                index: stepIndex,
                type: data.type || 'note',
                status: data.status || 'success',
                title: data.title || ''
            }
        });
    }
}

function buildPlannerMessages(goal, toolList, observations, runMode = 'standard', contextConfig = {}) {
    const context = normalizeContextConfig(contextConfig);
    const contextLines = [];
    if (context.mode === 'recent') contextLines.push('使用最近的对话上下文。');
    if (context.mode === 'knowledge') contextLines.push('使用知识库上下文。');
    if (context.mode === 'none') contextLines.push('不包含额外的会话上下文。');
    if (context.notes) contextLines.push(`附加说明：${context.notes}`);
    const runModeLabel = { standard: '标准模式—稳扎稳打', deep: '深度模式—允许额外检索', audit: '审计模式—必须强调证据、限制和风险', dag: 'DAG 模式—按工作流图执行' }[normalizeRunMode(runMode)] || normalizeRunMode(runMode);
    return [
        {
            role: 'system',
            content: [
                '你是 Pivot Agent。请仔细规划，在需要时调用工具，并返回简洁的结果。',
                '选择操作时只返回 JSON；仅在最终答案中使用 Markdown。',
                '【重要语言规则】你的思考（thought）、推理和最终答案必须使用中文。禁止使用英文提纲或英文推理过程。',
                'Schema: {"thought":"简短推理（中文）","action":"tool|final","tool":"tool.name","input":{},"answer":"最终答案（中文）"}',
                `运行模式：${runModeLabel}。`,
                '如果 action 为 tool，请选择一个可用的工具并提供 JSON 输入。如果 action 为 final，请提供答案。',
                '以观察结果为依据，不要编造工具返回结果。',
                contextLines.length ? `上下文指导：${contextLines.join(' ')}` : '无额外上下文指导。',
                '可用工具：',
                JSON.stringify(toolList, null, 2)
            ].join('\n')
        },
        {
            role: 'user',
            content: [
                `目标：${goal}`,
                '观察记录：',
                observations.length ? JSON.stringify(observations, null, 2) : '[]'
            ].join('\n\n')
        }
    ];
}

async function executeToolByName(name, input, user, toolList = []) {
    const safeName = String(name || '').trim();
    const tool = toolList.find(item => item.name === safeName);
    if (!tool) {
        const err = new Error(`工具不可用或无权访问：${safeName || '-'}`);
        err.status = 403;
        throw err;
    }
    if (safeName.startsWith('mcp.')) {
        return executeMcpTool(safeName, input, user, { source: 'agent' });
    }
    return executeBuiltInTool(safeName, input, user);
}

function isApprovalGranted(run, toolName) {
    // approveAgentTool persists approved tools in metadata.approvedTools.
    // Keep this check scoped so pendingApproval cleanup remains in the approval flow.
    const metadata = getRunMetadata(run);
    const approved = Array.isArray(metadata.approvedTools) ? metadata.approvedTools : [];
    return approved.includes(toolName);
}

function shouldPauseForApproval(run, tool) {
    if (!tool || tool.source !== 'mcp') return false;
    if (isApprovalGranted(run, tool.name)) return false;
    const policy = normalizeApprovalPolicy(run.approval_policy);
    if (policy === 'approve_all_mcp') return true;
    return Boolean(tool.requiresApproval || tool.risk === 'high');
}

function maybePauseForApproval(run, tool, input) {
    if (!shouldPauseForApproval(run, tool)) return false;
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
        error_message: `工具需要审批：${tool.title || tool.name}`,
        updated_at: now,
        last_heartbeat_at: now
    });
    insertStep(run.id, listSteps(run.id).length + 1, {
        type: 'approval',
        title: `等待工具审批：${tool.title || tool.name}`,
        toolName: tool.name,
        input,
        output: { status: 'approval_required', tool: tool.name }
    });
    createAgentNotification(run.user_id, run.id, 'approval', 'Agent run requires tool approval', tool.title || tool.name);
    return true;
}

async function synthesizeFinalAnswer(modelCfg, goal, observations, user = null, runId = '') {
    const messages = [
        {
            role: 'system',
            content: '你是 Pivot Agent。请将 Agent 的观察记录总结为清晰的最终答案。如适用，请说明局限性和有用的后续步骤。输出请使用中文。'
        },
        {
            role: 'user',
            content: `任务目标：${goal}\n\n执行观察：${JSON.stringify(observations, null, 2)}`
        }
    ];
    const content = await callModelText(modelCfg, messages, { user });
    if (user) recordAgentModelUsage(user, modelCfg, messages, content, 'agent_summary', runId);
    return content || '未能生成最终答案。';
}

function upsertDagNode(runId, node, patch = {}) {
    const existing = db.prepare('SELECT id FROM agent_dag_nodes WHERE run_id = ? AND node_key = ?').get(runId, node.id);
    const now = getBeijingTimestamp();
    const row = {
        title: patch.title ?? node.title,
        toolName: patch.toolName ?? node.tool,
        input: patch.input ?? node.input ?? {},
        dependsOn: patch.dependsOn ?? node.dependsOn ?? [],
        condition: patch.condition ?? node.condition ?? 'success',
        status: patch.status ?? 'pending',
        output: patch.output ?? null,
        errorMessage: patch.errorMessage ?? '',
        attemptCount: patch.attemptCount ?? 0,
        durationMs: patch.durationMs ?? null,
        startedAt: patch.startedAt ?? null,
        completedAt: patch.completedAt ?? null
    };
    if (existing) {
        db.prepare(`
            UPDATE agent_dag_nodes
            SET title = ?, tool_name = ?, input = ?, depends_on = ?, condition = ?, status = ?,
                output = ?, error_message = ?, attempt_count = ?, duration_ms = ?, started_at = ?, completed_at = ?
            WHERE id = ?
        `).run(
            row.title,
            row.toolName,
            JSON.stringify(row.input),
            JSON.stringify(row.dependsOn),
            row.condition,
            row.status,
            row.output === null ? null : JSON.stringify(row.output),
            row.errorMessage,
            row.attemptCount,
            row.durationMs,
            row.startedAt,
            row.completedAt,
            existing.id
        );
        return existing.id;
    }
    const info = db.prepare(`
        INSERT INTO agent_dag_nodes (
            run_id, node_key, title, tool_name, input, depends_on, condition, status,
            output, error_message, attempt_count, duration_ms, started_at, completed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        runId,
        node.id,
        row.title,
        row.toolName,
        JSON.stringify(row.input),
        JSON.stringify(row.dependsOn),
        row.condition,
        row.status,
        row.output === null ? null : JSON.stringify(row.output),
        row.errorMessage,
        row.attemptCount,
        row.durationMs,
        row.startedAt,
        row.completedAt,
        now
    );
    return info.lastInsertRowid;
}

// v0.0.49 supports streaming function calling for agent runs.
function isStreamingToolsEnabled() {
    return String(process.env.AGENT_STREAMING_TOOLS || '').toLowerCase() === 'true';
}

// Streaming mode converts agent tools into OpenAI tools schema for direct tool_calls.
// If the stream does not finish the run, return { completed: false } for JSON planner fallback.
async function tryRunAgentStreaming({ run, user, modelCfg, toolList, runId, deadline, assertRunWithinBudget, assertRunNotCancelled, observations }) {
    try {
        const tools = buildAgentToolSchemas(toolList);
        const systemPrompt = `你是 Pivot Agent。目标：${run.goal || ''}

需要时使用 tool_calls 调用工具；否则提供最终答案。返回结构化的工具输入 JSON。

【重要语言规则】你的思考、推理和所有输出必须使用中文。禁止使用英文提纲或英文推理过程。`;

        const conversation = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: run.goal || '' }
        ];
        let lastStep = listSteps(runId).length;
        const maxSteps = normalizeMaxSteps(run.max_steps);
        for (let step = lastStep + 1; step <= lastStep + maxSteps; step += 1) {
            assertRunWithinBudget();
            assertRunNotCancelled(runId);
            updateRun(runId, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
            const stepStart = Date.now();
            // Throttle streaming updates: emit at most every 100ms unless content grows enough.
            let lastEmittedAt = 0;
            let lastEmittedLen = 0;
            const emitDelta = (snapshot) => {
                if (!snapshot) return;
                const now = Date.now();
                const contentLen = (snapshot.content || '').length;
                const sizeDelta = Math.abs(contentLen - lastEmittedLen);
                if (now - lastEmittedAt < 100 && sizeDelta < 120) return;
                lastEmittedAt = now;
                lastEmittedLen = contentLen;
                publishUserEvent(user.id, 'agent.streaming', {
                    runId,
                    step,
                    content: snapshot.content || '',
                    partialToolCalls: snapshot.partialToolCalls || [],
                    finishReason: snapshot.finishReason || null
                });
            };
            const result = await withTimeout(
                callModelStreamingWithTools(modelCfg, conversation, tools, { temperature: 0.2, maxTokens: 1200, onDelta: emitDelta, user }),
                Math.min(180000, Math.max(deadline - Date.now(), 1000)),
                'streaming tool planning'
            );
            // Emit a final streaming snapshot so the UI can mark this step complete.
            publishUserEvent(user.id, 'agent.streaming', {
                runId,
                step,
                content: result?.content || '',
                partialToolCalls: (result?.toolCalls || []).map(c => ({ id: c.id, name: c.name, argumentsRaw: c.argumentsRaw })),
                finishReason: result?.finishReason || null,
                completed: true
            });
            recordAgentModelUsage(user, modelCfg, conversation, result?.content || '', 'agent_planner_streaming', runId);
            insertStep(runId, step, {
                type: 'plan',
                title: result?.hasToolCalls ? `Streaming tool plan: ${result.toolCalls.map(c => c.name).filter(Boolean).join(', ') || 'tool'}` : 'Streaming final answer',
                input: { goal: run.goal },
                output: {
                    content: result?.content || '',
                    toolCalls: (result?.toolCalls || []).map(c => ({ id: c.id, name: c.name, arguments: c.arguments || c.argumentsRaw })),
                    finishReason: result?.finishReason || ''
                },
                durationMs: Date.now() - stepStart
            });

            if (!result?.hasToolCalls) {
                const answer = result?.content || await synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId);
                updateRun(runId, {
                    status: 'completed',
                    final_answer: answer,
                    completed_at: getBeijingTimestamp(),
                    last_heartbeat_at: getBeijingTimestamp(),
                    updated_at: getBeijingTimestamp()
                });
                createAgentNotification(user.id, runId, 'completed', 'Agent run completed', getAgentRunTitle(run));
                return { completed: true };
            }

            // Persist the assistant tool-call message before appending tool results.
            conversation.push(buildAssistantToolMessage(result));

            // Execute each requested tool call and append its result back to the conversation.
            for (const call of result.toolCalls) {
                assertRunWithinBudget();
                assertRunNotCancelled(runId);
                const selectedTool = toolList.find(t => t.name === call.name);
                if (!selectedTool) {
                    const message = `工具不可用或无权访问：${call.name || '-'}`;
                    conversation.push(buildToolResultMessage(call.id, { error: message }));
                    insertStep(runId, listSteps(runId).length + 1, {
                        type: 'tool',
                        title: `工具不可用：${call.name || '-'}`,
                        toolName: call.name || '',
                        input: call.arguments || {},
                        output: { error: message },
                        errorMessage: message,
                        status: 'error'
                    });
                    continue;
                }
                if (maybePauseForApproval(run, selectedTool, call.arguments || {})) {
                    // Leave the run in approval_required; the resume path continues after approval.
                    return { completed: true };
                }
                const callStart = Date.now();
                try {
                    const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
                    const output = await withTimeout(
                        executeToolByName(call.name, args, user, toolList),
                        Math.min(normalizePositiveInt(run.tool_timeout_ms, AGENT_TOOL_TIMEOUT_MS, 30000, 10 * 60 * 1000), Math.max(deadline - Date.now(), 1000)),
                        `执行工具：${call.name}`
                    );
                    const compactOutput = clampText(output, 10000);
                    observations.push({ step, tool: call.name, input: args, output: compactOutput });
                    insertStep(runId, listSteps(runId).length + 1, {
                        type: 'tool',
                        title: `工具执行完成：${call.name}`,
                        toolName: call.name,
                        input: args,
                        output: compactOutput,
                        durationMs: Date.now() - callStart
                    });
                    conversation.push(buildToolResultMessage(call.id, compactOutput));
                } catch (toolErr) {
                    observations.push({ step, tool: call.name, input: call.arguments || {}, error: toolErr.message });
                    insertStep(runId, listSteps(runId).length + 1, {
                        type: 'tool',
                        title: `工具执行失败：${call.name}`,
                        toolName: call.name,
                        input: call.arguments || {},
                        output: { error: toolErr.message },
                        errorMessage: toolErr.message,
                        status: 'error',
                        durationMs: Date.now() - callStart
                    });
                    conversation.push(buildToolResultMessage(call.id, { error: toolErr.message }));
                }
            }
        }
        // No final answer was produced in streaming mode, so fall back to the JSON planner.
        return { completed: false };
    } catch (streamErr) {
        // Streaming failed unexpectedly; record a control step and continue with JSON planning.
        logger.warn({ runId, err: streamErr.message }, 'Streaming tool call failed; falling back to JSON planner');
        insertStep(runId, listSteps(runId).length + 1, {
            type: 'control',
            title: 'Streaming tool fallback',
            output: { error: streamErr.message }
        });
        return { completed: false };
    }
}

async function executeDagNodeWithPolicy({ run, user, node, resolvedInput, toolList, deadline, policy }) {
    const startedAt = Date.now();
    const startedAtText = getBeijingTimestamp();
    let lastError = null;
    const attempts = Math.max(1, Number(policy.retryLimit || 0) + 1);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        assertRunNotCancelled(run.id);
        try {
            const output = await withTimeout(
                executeToolByName(node.tool, resolvedInput, user, toolList),
                Math.min(policy.timeoutMs, Math.max(deadline - Date.now(), 1000)),
                `执行 DAG 节点：${node.title || node.id}`
            );
            return {
                ok: true,
                output,
                attempt,
                startedAt,
                startedAtText,
                durationMs: Date.now() - startedAt
            };
        } catch (e) {
            lastError = e;
            insertStep(run.id, listSteps(run.id).length + 1, {
                type: 'dag',
                title: `DAG node retry ${node.title || node.id} (${attempt}/${attempts})`,
                toolName: node.tool,
                input: resolvedInput,
                output: { error: e.message, attempt, attempts, retrying: attempt < attempts },
                errorMessage: e.message,
                status: attempt < attempts ? 'success' : 'error',
                durationMs: Date.now() - startedAt
            });
            if (attempt >= attempts) break;
        }
    }
    return {
        ok: false,
        error: lastError || new Error('DAG node failed without an error message.'),
        attempt: attempts,
        startedAt,
        startedAtText,
        durationMs: Date.now() - startedAt
    };
}

async function runAgentDag({ run, user, modelCfg, toolList, deadline, assertRunWithinBudget }) {
    const metadata = getRunMetadata(run);
    const dagSpec = normalizeDagSpec(metadata.dagSpec || metadata.dag || {});
    const dagInputs = normalizeDagRunInputs(metadata.dagInputs || metadata.inputs || {});
    const reusedDagNodes = metadata.reusedDagNodes && typeof metadata.reusedDagNodes === 'object' ? metadata.reusedDagNodes : {};
    if (!dagSpec.nodes.length) {
        throw new Error('DAG mode requires at least one valid node.');
    }

    dagSpec.nodes.forEach(node => upsertDagNode(run.id, node, { status: 'pending' }));
    const nodeMap = new Map(dagSpec.nodes.map(node => [node.id, node]));
    const states = new Map(dagSpec.nodes.map(node => [node.id, { status: 'pending' }]));
    Object.entries(reusedDagNodes).forEach(([nodeId, state]) => {
        states.set(nodeId, {
            status: state?.status || 'completed',
            input: state?.input || {},
            output: state?.output,
            compactOutput: clampText(state?.output, 12000),
            reused: true
        });
    });
    const observations = [];
    let stepIndex = listSteps(run.id).length + 1;

    while ([...states.values()].some(state => state.status === 'pending')) {
        assertRunWithinBudget();
        assertRunNotCancelled(run.id);
        const readyNodes = dagSpec.nodes.filter(node => {
            const state = states.get(node.id);
            if (state?.status !== 'pending') return false;
            return node.dependsOn.every(dep => ['completed', 'error', 'skipped'].includes(states.get(dep)?.status));
        });
        if (!readyNodes.length) {
            throw new Error('DAG execution stalled because no nodes are runnable.');
        }

        const runnable = [];
        const stopErrors = [];
        readyNodes.forEach(node => {
            const depStates = node.dependsOn.map(dep => states.get(dep)?.status);
            if (node.condition !== 'always' && depStates.some(status => status !== 'completed')) {
                states.set(node.id, { status: 'skipped' });
                upsertDagNode(run.id, node, {
                    status: 'skipped',
                    output: { status: 'skipped', reason: 'dependency_not_completed' },
                    completedAt: getBeijingTimestamp()
                });
                insertStep(run.id, stepIndex, {
                    type: 'dag',
                    title: `跳过 DAG 节点：${node.title || node.id}`,
                    toolName: node.tool,
                    input: node.input,
                    output: { status: 'skipped', dependsOn: node.dependsOn }
                });
                stepIndex += 1;
            } else {
                runnable.push(node);
            }
        });

        await Promise.all(runnable.slice(0, AGENT_DAG_NODE_CONCURRENCY).map(async node => {
            const selectedTool = toolList.find(tool => tool.name === node.tool);
            const resolvedInput = resolveDagNodeInput(node, {
                goal: run.goal,
                inputs: dagInputs,
                states,
                nodeMap
            });
            if (maybePauseForApproval(run, selectedTool, resolvedInput)) {
                const err = new Error('DAG node requires tool approval.');
                err.code = 'AGENT_APPROVAL_REQUIRED';
                throw err;
            }
            const policy = normalizeDagNodePolicy(node, run, AGENT_TOOL_TIMEOUT_MS);
            const startedAtText = getBeijingTimestamp();
            states.set(node.id, { status: 'running', input: resolvedInput });
            upsertDagNode(run.id, node, { status: 'running', input: resolvedInput, startedAt: startedAtText });
            try {
                const result = await executeDagNodeWithPolicy({ run, user, node, resolvedInput, toolList, deadline, policy });
                assertRunNotCancelled(run.id);
                if (!result.ok) {
                    result.error.dagAttempt = result.attempt;
                    result.error.dagDurationMs = result.durationMs;
                    throw result.error;
                }
                const { output } = result;
                const compactOutput = clampText(output, 12000);
                states.set(node.id, { status: 'completed', input: resolvedInput, output, compactOutput, attemptCount: result.attempt });
                upsertDagNode(run.id, node, {
                    status: 'completed',
                    input: resolvedInput,
                    output: compactOutput,
                    attemptCount: result.attempt,
                    durationMs: result.durationMs,
                    completedAt: getBeijingTimestamp()
                });
                observations.push({ node: node.id, title: node.title, tool: node.tool, input: resolvedInput, output: compactOutput, attempts: result.attempt });
                insertStep(run.id, stepIndex, {
                    type: 'dag',
                    title: `完成 DAG 节点：${node.title || node.id}`,
                    toolName: node.tool,
                    input: resolvedInput,
                    output: compactOutput,
                    durationMs: result.durationMs
                });
            } catch (e) {
                const attemptCount = Number(e.dagAttempt || Math.max(1, Number(policy.retryLimit || 0) + 1));
                const durationMs = Number(e.dagDurationMs || 0);
                const status = policy.onError === 'continue' ? 'completed' : 'error';
                states.set(node.id, {
                    status,
                    input: resolvedInput,
                    error: e.message,
                    output: policy.onError === 'continue' ? { error: e.message, continued: true } : undefined,
                    attemptCount,
                    onError: policy.onError
                });
                upsertDagNode(run.id, node, {
                    status,
                    input: resolvedInput,
                    output: { error: e.message, onError: policy.onError },
                    errorMessage: e.message,
                    attemptCount,
                    durationMs,
                    completedAt: getBeijingTimestamp()
                });
                observations.push({ node: node.id, title: node.title, tool: node.tool, input: resolvedInput, error: e.message, onError: policy.onError, attempts: attemptCount });
                insertStep(run.id, stepIndex, {
                    type: 'dag',
                    title: policy.onError === 'continue' ? `DAG 节点失败后继续：${node.title || node.id}` : `DAG 节点执行失败：${node.title || node.id}`,
                    toolName: node.tool,
                    input: resolvedInput,
                    output: { error: e.message, onError: policy.onError },
                    errorMessage: e.message,
                    status: policy.onError === 'continue' ? 'success' : 'error',
                    durationMs
                });
                if (policy.onError === 'stop') stopErrors.push(e);
            } finally {
                stepIndex += 1;
                updateRun(run.id, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
            }
        }));
        if (stopErrors.length) throw stopErrors[0];
    }

    const failedNodes = dagSpec.nodes.filter(node => states.get(node.id)?.status === 'error');
    const skippedNodes = dagSpec.nodes.filter(node => states.get(node.id)?.status === 'skipped');
    if (failedNodes.length || skippedNodes.length) {
        insertStep(run.id, stepIndex, {
            type: 'control',
            title: failedNodes.length ? 'DAG completed with failed nodes' : 'DAG completed with skipped nodes',
            output: {
                failedNodes: failedNodes.map(node => ({
                    id: node.id,
                    title: node.title,
                    error: states.get(node.id)?.error || ''
                })),
                skippedNodes: skippedNodes.map(node => ({ id: node.id, title: node.title }))
            },
            status: failedNodes.length ? 'error' : 'success'
        });
    }

    const answer = await withTimeout(
        synthesizeFinalAnswer(modelCfg, run.goal, observations, user, run.id),
        Math.min(180000, Math.max(deadline - Date.now(), 1000)),
        'DAG final summary'
    );
    updateRun(run.id, {
        status: 'completed',
        final_answer: answer,
        error_message: failedNodes.length ? `DAG failed nodes: ${failedNodes.length}` : '',
        completed_at: getBeijingTimestamp(),
        last_heartbeat_at: getBeijingTimestamp(),
        updated_at: getBeijingTimestamp()
    });
    createAgentNotification(
        user.id,
        run.id,
        failedNodes.length ? 'warning' : 'completed',
        failedNodes.length ? 'DAG run completed with errors' : 'DAG run completed',
        getAgentRunTitle(run)
    );
}

async function runAgent(runId, user) {
    try {
        const run = getRunForUser(runId, user, { includeDeleted: true });
        if (!run) throw new Error('Agent run not found.');
        if (run.deleted_at) return;
        assertRunNotCancelled(runId);
        const deadline = Date.now() + normalizePositiveInt(run.timeout_ms, AGENT_DEFAULT_TIMEOUT_MS, 60000, 24 * 60 * 60 * 1000);
        const assertRunWithinBudget = () => {
            if (Date.now() > deadline) {
                const err = new Error('Agent run timed out.');
                err.code = 'AGENT_TIMEOUT';
                throw err;
            }
        };
        const initialModelCfg = getRunnableModelForUser(run.model_id, user);
        if (!initialModelCfg) throw new Error('No accessible model is available for this agent run.');
        // run.model_router controls whether the initial model is fixed, routed up front, or escalated later.
        let modelCfg = initialModelCfg;
        const routerStrategy = normalizeRouterStrategy(run.model_router);
        if (routerStrategy !== 'fixed') {
            try {
                const routed = chooseModel({
                    user,
                    strategy: routerStrategy,
                    hintModelId: run.model_id,
                    messages: [{ role: 'user', content: run.goal || '' }],
                    endpointStatusGetter: getModelEndpointRuntimeStatus
                });
                if (routed && routed.model && routed.model.id !== initialModelCfg.id) {
                    modelCfg = routed.model;
                    db.prepare('UPDATE agent_runs SET chosen_model_id = ?, updated_at = ? WHERE id = ?')
                        .run(modelCfg.id, getBeijingTimestamp(), runId);
                    insertStep(runId, listSteps(runId).length + 1, {
                        type: 'control',
                        title: `模型路由选择：${routerStrategy}`,
                        output: { strategy: routerStrategy, chosenModelId: modelCfg.id, chosenModelName: modelCfg.name || modelCfg.model_name || '', reason: routed.reason || '', candidatesCount: routed.candidatesCount || 0 }
                    });
                    logger.info({ runId, strategy: routerStrategy, originalModelId: initialModelCfg.id, chosenModelId: modelCfg.id, reason: routed.reason }, 'Agent model router selected a model');
                }
            } catch (routerErr) {
                logger.warn({ runId, err: routerErr.message }, 'Agent model routing failed; using original model');
            }
        }

        const observations = [];
        const toolList = formatToolList(user, {
            toolPolicy: run.tool_policy,
            toolAllowlist: run.tool_allowlist
        });
        if (toolList.length === 0) {
            throw new Error('No available tools match this agent configuration.');
        }
        assertRunNotCancelled(runId);
        const startedAt = getBeijingTimestamp();
        updateRun(runId, {
            status: 'running',
            started_at: run.started_at || startedAt,
            last_heartbeat_at: startedAt,
            updated_at: startedAt
        });

        if (normalizeRunMode(run.run_mode) === 'dag') {
            await runAgentDag({ run, user, modelCfg, toolList, deadline, assertRunWithinBudget });
            return;
        }

        // Prefer streaming function calling when enabled so the model can issue tool_calls directly.
        // If streaming does not complete, the JSON planner below continues from collected observations.
        if (isStreamingToolsEnabled()) {
            const streamingResult = await tryRunAgentStreaming({
                run, user, modelCfg, toolList, runId, deadline, assertRunWithinBudget, assertRunNotCancelled, observations
            });
            if (streamingResult?.completed) return;
            // Streaming emitted partial work but did not finish; continue with the JSON planner path.
        }

        for (let step = 1; step <= normalizeMaxSteps(run.max_steps); step += 1) {
            assertRunWithinBudget();
            assertRunNotCancelled(runId);
            updateRun(runId, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
            const plannerMessages = buildPlannerMessages(run.goal, toolList, observations, run.run_mode, parseJsonObject(run.context_config) || {});
            const plannedText = await withTimeout(callModelText(modelCfg, plannerMessages, { user }), Math.min(180000, Math.max(deadline - Date.now(), 1000)), '智能体规划');
            recordAgentModelUsage(user, modelCfg, plannerMessages, plannedText, 'agent_planner', runId);
            assertRunWithinBudget();
            assertRunNotCancelled(runId);
            const plan = parseJsonObject(plannedText) || {};
            insertStep(runId, step, {
                type: 'plan',
                title: plan.thought || 'Agent plan',
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
                createAgentNotification(user.id, runId, 'completed', 'Agent run completed', getAgentRunTitle(run));
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
                    `执行工具：${plan.tool}`
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
                    title: `工具执行完成：${plan.tool}`,
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
                    title: `工具执行失败：${plan.tool}`,
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
        let answer = await withTimeout(synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId), Math.min(180000, Math.max(deadline - Date.now(), 1000)), 'final summary');
        // v0.0.50 auto-escalate retries the final summary with a stronger model when confidence is low.
        if (routerStrategy === 'auto-escalate') {
            const confidence = assessConfidence({ output: answer });
            if (!confidence.confident) {
                try {
                    const escalation = pickEscalationModel({
                        user,
                        currentModel: modelCfg,
                        messages: [{ role: 'user', content: run.goal || '' }]
                    });
                    if (escalation) {
                        insertStep(runId, listSteps(runId).length + 1, {
                            type: 'control',
                            title: '模型自动升级：auto-escalate',
                            output: { reason: confidence.reason, fromModelId: modelCfg.id, toModelId: escalation.id, toModelName: escalation.name || escalation.model_name || '' }
                        });
                        logger.info({ runId, reason: confidence.reason, fromModelId: modelCfg.id, toModelId: escalation.id }, 'Agent confidence low; escalating model');
                        modelCfg = escalation;
                        db.prepare('UPDATE agent_runs SET chosen_model_id = ?, updated_at = ? WHERE id = ?')
                            .run(modelCfg.id, getBeijingTimestamp(), runId);
                        answer = await withTimeout(synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId), Math.min(180000, Math.max(deadline - Date.now(), 1000)), 'escalated final summary');
                    }
                } catch (escErr) {
                    logger.warn({ runId, err: escErr.message }, 'auto-escalate failed; keeping first answer');
                }
            }
        }
        assertRunNotCancelled(runId);
        updateRun(runId, {
            status: 'completed',
            final_answer: answer,
            completed_at: getBeijingTimestamp(),
            last_heartbeat_at: getBeijingTimestamp(),
            updated_at: getBeijingTimestamp()
        });
        createAgentNotification(user.id, runId, 'completed', 'Agent run completed', getAgentRunTitle(run));
    } catch (e) {
        if (e.code === 'AGENT_RUN_CANCELLED') {
            updateRun(runId, { updated_at: getBeijingTimestamp() });
            return;
        }
        if (e.code === 'AGENT_APPROVAL_REQUIRED') {
            updateRun(runId, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
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
                title: `任务失败重试：${retryCount + 1}/${retryLimit}`,
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
        createAgentNotification(user.id, runId, 'error', 'Agent run failed', e.message);
    }
}

function enqueueAgentRun(runId, _user) {
    getAgentQueue().enqueueRun(runId);
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
            error_message: 'Service restarted or heartbeat timed out; run marked as error.',
            completed_at: now,
            updated_at: now,
            last_heartbeat_at: now,
            locked_by: null,
            lock_expires_at: null
        });
        insertStep(run.id, listSteps(run.id).length + 1, {
            type: 'control',
            title: 'Runtime recovery marked stale run',
            output: { status: 'error', reason: 'stale_running' }
        });
    });

    const recoveredQueued = getAgentQueue().recoverQueued(100);
    logger.info({ recoveredQueued, staleRunning: staleRunning.length }, 'Agent runtime recovery completed');
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
            error_message: `用户拒绝工具审批：${pending.tool || '-'}`,
            cancelled_at: now,
            completed_at: now,
            updated_at: now
        });
        setRunMetadata(runId, { pendingApproval: null });
        insertStep(runId, listSteps(runId).length + 1, {
            type: 'approval',
            title: 'User rejected tool approval',
            toolName: pending.tool || '',
            output: { status: 'rejected' }
        });
        createAgentNotification(user.id, runId, 'cancelled', 'Agent approval rejected', pending.tool || getAgentRunTitle(run));
        return getRunForUser(runId, user);
    }
    const approvedTools = new Set(Array.isArray(metadata.approvedTools) ? metadata.approvedTools : []);
    if (pending.tool) approvedTools.add(pending.tool);
    setRunMetadata(runId, { pendingApproval: null, approvedTools: [...approvedTools] });
    updateRun(runId, { status: 'queued', error_message: '', updated_at: now });
    insertStep(runId, listSteps(runId).length + 1, {
        type: 'approval',
        title: 'User approved tool call',
        toolName: pending.tool || '',
        output: { status: 'approved', tool: pending.tool || '' }
    });
    enqueueAgentRun(runId, user);
    return getRunForUser(runId, user);
}

function getAgentRuntimeStatus(user = null) {
    return buildAgentRuntimeStatus({
        maxConcurrent: AGENT_MAX_CONCURRENT_RUNS,
        dagNodeConcurrency: AGENT_DAG_NODE_CONCURRENCY,
        queueStatus: getAgentQueue().getStatus(),
        user
    });
}

configureAgentSchedules({
    createAgentRun,
    createAgentNotification
});

configureAgentArtifacts({
    createAgentNotification,
    getAgentRunTitle,
    getRunDetailForUser: getRunDetailForUserHelper
});

function inferDagRunGoal({ goal, title, workflowId, runMetadata = {}, dagSpec = null, user = {} }) {
    const explicitGoal = String(goal || '').trim();
    if (explicitGoal) return explicitGoal;
    const metadataWorkflowName = String(runMetadata.workflowName || runMetadata.workflow_name || '').trim();
    if (metadataWorkflowName) return `执行工作流：${metadataWorkflowName}`;
    const requestedWorkflowId = Number.parseInt(workflowId || runMetadata.workflowId || runMetadata.workflow_id, 10);
    if (requestedWorkflowId && user?.id) {
        const workflow = db.prepare('SELECT name FROM agent_workflows WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
            .get(requestedWorkflowId, user.id);
        if (workflow?.name) return `执行工作流：${workflow.name}`;
    }
    const cleanTitle = String(title || '').trim();
    if (cleanTitle) return cleanTitle;
    const normalizedDag = normalizeDagSpec(dagSpec || runMetadata.dagSpec || runMetadata.dag || {});
    if (normalizedDag.nodes.length) return `执行当前工作流（${normalizedDag.nodes.length} 个节点）`;
    return '';
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
    metadata = {},
    dagSpec = null,
    dagInputs = null,
    workflowId = null,
    workflowVersion = null,
    modelRouter = 'fixed'
}) {
    const normalizedToolPolicy = normalizeToolPolicy(toolPolicy);
    const normalizedRunMode = normalizeRunMode(runMode);
    const normalizedRouter = normalizeRouterStrategy(modelRouter);
    const runMetadata = metadata && typeof metadata === 'object' ? { ...metadata } : {};
    const cleanGoal = normalizeAgentGoal(normalizedRunMode === 'dag'
        ? inferDagRunGoal({ goal, title, workflowId, runMetadata, dagSpec, user })
        : goal);
    const modelCfg = getRunnableModelForUser(modelId, user);
    if (!modelCfg) throw new Error('Please choose an accessible model for the agent.');
    const runId = createRunId();
    const now = getBeijingTimestamp();
    const normalizedDagInputs = normalizeDagInputsPayload(dagInputs || runMetadata.dagInputs || runMetadata.inputs || {});
    if (Object.keys(normalizedDagInputs).length) {
        runMetadata.dagInputs = normalizedDagInputs;
    }
    if (normalizedRunMode === 'dag') {
        const requestedWorkflowId = workflowId || runMetadata.workflowId || runMetadata.workflow_id || null;
        const requestedWorkflowVersion = workflowVersion || runMetadata.workflowVersion || runMetadata.workflow_version || null;
        if (requestedWorkflowId && requestedWorkflowVersion) {
            const resolvedWorkflow = resolveAgentWorkflowVersion(requestedWorkflowId, user, requestedWorkflowVersion || 'current');
            if (!resolvedWorkflow) {
                const err = new Error('Workflow version is not available.');
                err.status = 404;
                throw err;
            }
            runMetadata.dagSpec = resolvedWorkflow.dagSpec;
            runMetadata.workflowId = resolvedWorkflow.workflow.id;
            runMetadata.workflowName = resolvedWorkflow.workflow.name;
            runMetadata.workflowVersion = resolvedWorkflow.version;
            runMetadata.workflowVersionMode = resolvedWorkflow.mode;
            runMetadata.workflowVersionId = resolvedWorkflow.version_id;
        } else {
            runMetadata.dagSpec = normalizeDagSpec(dagSpec || runMetadata.dagSpec || {});
        }
    }
    db.prepare(`
        INSERT INTO agent_runs (
            id, user_id, session_id, model_id, title, goal, status, max_steps, parent_run_id,
            priority, run_mode, tool_policy, tool_allowlist, approval_policy, timeout_ms, tool_timeout_ms,
            retry_limit, max_token_budget, template_id, schedule_id, context_config, resume_from_step,
            metadata, model_router, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        runId,
        user.id,
        sessionId || null,
        modelCfg.id,
        normalizeAgentTitle(title, cleanGoal),
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
        JSON.stringify(runMetadata),
        normalizedRouter,
        now,
        now
    );
    enqueueAgentRun(runId, user);
    const run = getRunForUser(runId, user);
    publishAgentRunEvent(runId, 'created');
    return run;
}

module.exports = {
    createAgentRun,
    createAgentArtifactVersion,
    createAgentSchedule,
    createAgentTemplate,
    createAgentWorkflow,
    cancelAgentRun,
    computeNextScheduleRun,
    deleteAgentSchedule,
    deleteAgentTemplate,
    deleteAgentWorkflow,
    approveAgentTool,
    diffAgentArtifactVersions,
    diffAgentWorkflowVersions,
    exportAgentRun,
    formatToolList,
    getAgentArtifactForUser,
    getAgentWorkflowForUser,
    listAgentArtifacts,
    listAgentArtifactVersions,
    listAgentNotifications,
    listAgentSchedules,
    listAgentTemplates,
    listAgentWorkflowVersions,
    listAgentWorkflows,
    getAgentMetrics,
    getAgentRuntimeStatus,
    normalizeAgentGoal,
    normalizeDagSpec,
    normalizeRunMode,
    normalizeApprovalPolicy,
    normalizeToolAllowlist,
    normalizeToolPolicy,
    parseJsonObject,
    publishAgentWorkflowVersion,
    rerunAgentRun,
    rerunAgentDagFromNode,
    resumeAgentRun,
    restoreAgentWorkflow,
    restoreAgentWorkflowVersion,
    recoverAgentRuns,
    runAgentScheduleNow,
    runDueAgentSchedules,
    runAgent,
    rollbackAgentArtifactVersion,
    saveAgentRunArtifact,
    shouldPauseForApproval,
    softDeleteAgentRun
    ,
    markAgentNotificationRead,
    startAgentScheduleRunner,
    updateAgentSchedule,
    updateAgentTemplate,
    updateAgentWorkflow
};
