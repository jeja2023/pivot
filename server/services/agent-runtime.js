const crypto = require('crypto');
const { db } = require('../db');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { getRunnableModelForUser } = require('./models');
const { clampText, executeToolByName, findAgentToolByName } = require('./agent-tool-runtime');
const { runAgentDag } = require('./agent-dag-runtime');
const { isStreamingToolsEnabled, tryRunAgentStreaming } = require('./agent-streaming-runtime');
const { createAgentQueue } = require('./agent-queue');
const { callModelText, recordAgentModelUsage } = require('./agent-model');
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
    assertWorkflowHasConfiguredLlm,
    listAgentWorkflowVersions,
    listAgentWorkflows,
    normalizeDagInputsPayload,
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
const { formatToolList } = require('./agent-tool-catalog');
const {
    getAgentMetrics,
    getAgentRuntimeStatus: buildAgentRuntimeStatus
} = require('./agent-monitoring');
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

function isPreviewAgentRun(run) {
    const metadata = getRunMetadata(run);
    return String(metadata.workflowRunSource || metadata.workflow_run_source || metadata.runSource || '').toLowerCase() === 'preview';
}

function createAgentNotification(userId, runId, type, title, body = '') {
    if (!userId || !title) return null;
    const run = runId
        ? db.prepare('SELECT title, goal, metadata FROM agent_runs WHERE id = ?').get(runId)
        : null;
    if (run && isPreviewAgentRun(run)) return null;
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

function isMissingFinalAnswer(value) {
    const text = String(value || '').trim();
    return !text
        || text === '\u672a\u80fd\u751f\u6210\u6700\u7ec8\u7b54\u6848\u3002'
        || text === 'No final answer was generated.';
}

function getAgentRuntimeDeps() {
    return {
        agentToolTimeoutMs: AGENT_TOOL_TIMEOUT_MS,
        dagNodeConcurrency: AGENT_DAG_NODE_CONCURRENCY,
        db,
        logger,
        assertRunNotCancelled,
        createAgentNotification,
        getAgentRunTitle,
        getRunMetadata,
        insertStep,
        isMissingFinalAnswer,
        listSteps,
        maybePauseForApproval,
        parseJsonObject,
        publishUserEvent,
        synthesizeFinalAnswer,
        updateRun,
        withTimeout
    };
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
            await runAgentDag({ run, user, modelCfg, toolList, deadline, assertRunWithinBudget }, getAgentRuntimeDeps());
            return;
        }

        // Prefer streaming function calling when enabled so the model can issue tool_calls directly.
        // If streaming does not complete, the JSON planner below continues from collected observations.
        if (isStreamingToolsEnabled()) {
            const streamingResult = await tryRunAgentStreaming({
                run, user, modelCfg, toolList, runId, deadline, assertRunWithinBudget, assertRunNotCancelled, observations
            }, getAgentRuntimeDeps());
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
                const selectedTool = findAgentToolByName(plan.tool, toolList);
                if (maybePauseForApproval(run, selectedTool, plan.input || {})) return;
                const output = await withTimeout(
                    executeToolByName(plan.tool, plan.input || {}, user, toolList, { run, modelCfg }),
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

function inferDagLlmRuntimeSettings(dagSpec = {}) {
    const nodes = Array.isArray(dagSpec?.nodes) ? dagSpec.nodes : [];
    const llmNode = nodes.find(node => String(node?.tool || '').trim() === 'agent.llm');
    const input = llmNode?.input && typeof llmNode.input === 'object' ? llmNode.input : {};
    const maxSteps = Number.parseInt(input.maxSteps ?? input.max_steps, 10);
    return {
        modelId: String(input.model || input.modelId || input.model_id || '').trim(),
        maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps : null
    };
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
    const runId = createRunId();
    const now = getBeijingTimestamp();
    const normalizedDagInputs = normalizeDagInputsPayload(dagInputs || runMetadata.dagInputs || runMetadata.inputs || {});
    if (Object.keys(normalizedDagInputs).length) {
        runMetadata.dagInputs = normalizedDagInputs;
    }
    let effectiveModelId = modelId;
    let effectiveMaxSteps = maxSteps;
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
        assertWorkflowHasConfiguredLlm(runMetadata.dagSpec);
        const llmRuntimeSettings = inferDagLlmRuntimeSettings(runMetadata.dagSpec);
        if (!effectiveModelId && llmRuntimeSettings.modelId) effectiveModelId = llmRuntimeSettings.modelId;
        if (llmRuntimeSettings.maxSteps) effectiveMaxSteps = llmRuntimeSettings.maxSteps;
    }
    const modelCfg = getRunnableModelForUser(effectiveModelId, user);
    if (!modelCfg) throw new Error('Please choose an accessible model for the agent.');
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
        normalizeMaxSteps(effectiveMaxSteps),
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
