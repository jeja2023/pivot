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
    const fallbackTitle = run ? getAgentRunTitle(run) : '闁哄懘缂氶崗妯绘媴閹剧儵鍋撳杈╁弨';
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
        title: `闁煎搫鍊婚崑锝夋煂瀹ュ牏鐛撻柨?{getAgentRunTitle(run)}`.slice(0, 80),
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
        `濞戞挸锕ｇ粩瀛樻姜椤旀儳笑闁诡兛绶ょ槐?{run.status}`,
        run.final_answer ? `濞戞挸锕ｇ粩瀛樻姜椤斿墽娉㈤悹浣哄皑缁?{clampText(run.final_answer, 1200)}` : '',
        run.error_message ? `濞戞挸锕ｇ粩瀛樻姜椤曗偓閺佸﹦鎷犻銈囩獥${run.error_message}` : '',
        failed.length ? `闁哄牃鍋撻弶鈺傚灥閵囨垹鎷归妷锔诲妱濡ょ姰鍊х槐?{JSON.stringify(failed.map(step => ({ step: step.step_index, tool: step.tool_name, error: step.error_message })))}` : ''
    ].filter(Boolean).join('\n');
    const previousMetadata = getRunMetadata(run);
    return createAgentRun({
        user,
        goal: resumeGoal,
        modelId: run.model_id,
        sessionId: run.session_id,
        title: `缂備綀鍛暰闁?{getAgentRunTitle(run)}`.slice(0, 80),
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
        title: '闁活潿鍔嶉崺娑氱矓婵犳碍鐝熷ù鐘侯嚙婵喓鎷嬮弶璺ㄧЭ',
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
    if (context.mode === 'recent') contextLines.push('Use recent conversation context.');
    if (context.mode === 'knowledge') contextLines.push('Use knowledge-base context.');
    if (context.mode === 'none') contextLines.push('Do not include extra session context.');
    if (context.notes) contextLines.push(`闁活潿鍔嶉崺娑氭偘閵夈儱甯犲☉鎾筹梗缁楀懘寮崶椋庣獥${context.notes}`);
    return [
        {
            role: 'system',
            content: [
                'You are a Pivot agent. Plan carefully, call tools when useful, and return concise results.',
                'Respond with JSON only when choosing an action; use Markdown only in final answers.',
                'Schema: {"thought":"short reasoning","action":"tool|final","tool":"tool.name","input":{},"answer":"final answer"}',
                `Run mode: ${normalizeRunMode(runMode)}. Standard is steady; deep allows extra retrieval; audit must emphasize evidence, limits, and risks.`,
                'If action is tool, choose exactly one available tool and provide JSON input. If action is final, provide answer.',
                'Use observations as evidence and avoid inventing tool results.',
                contextLines.length ? `Context guidance: ${contextLines.join(' ')}` : 'No additional context guidance.',
                'Available tools:',
                JSON.stringify(toolList, null, 2)
            ].join('\n')
        },
        {
            role: 'user',
            content: [
                `闁烩晩鍠楅悥锝夋晬?{goal}`,
                'Observations:',
                observations.length ? JSON.stringify(observations, null, 2) : '[]'
            ].join('\n\n')
        }
    ];
}

async function executeToolByName(name, input, user, toolList = []) {
    const safeName = String(name || '').trim();
    const tool = toolList.find(item => item.name === safeName);
    if (!tool) {
        const err = new Error(`鐎规悶鍎遍崣鍧楀嫉椤忓懎鎴块柡澶婂暞閸ㄣ劍绋夊鍛闁汇埄鐓夌槐?{safeName || '-'}`);
        err.status = 403;
        throw err;
    }
    if (safeName.startsWith('mcp.')) {
        return executeMcpTool(safeName, input, user, { source: 'agent' });
    }
    return executeBuiltInTool(safeName, input, user);
}

function isApprovalGranted(run, toolName) {
    // 閻庡厜鍓濇竟鎺旂磼閹惧浜柛娆樹簼婢规瑧鎷嬮妶澶嗗亾濮樺磭绠?approveAgentTool 闁告劖鐟ラ崣鍡涙儍?approvedTools 闁谎嗘閹洟宕￠弴顏嗙
    // 濞戞挸绉撮崯鈧柡鈧娑樼槷 metadata.approval 閺夆晜鐟х悮?闁稿繈鍔岄惇顒勫绩閹规劦鏀?闁活収鍙€閻箖鏁嶅畝鍕級闁稿繐绉撮幃妤冪磼椤擄紕鐔呴柣銏ｉ哺婢ц法浠﹂弴鐔割槯閻炴凹鍋嗙划顐ｆ交閸ャ儮鍋?
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
        error_message: `缂佹稑顦欢鐔兼偨閵婏箑鐓曢悗鍏夊墲婢规帡鎳楅挊澶婎潝閹煎瓨鎸告导鎰板礂閸戙倗绐?{tool.title || tool.name}`,
        updated_at: now,
        last_heartbeat_at: now
    });
    insertStep(run.id, listSteps(run.id).length + 1, {
        type: 'approval',
        title: `缂佹稑顦欢鐔衡偓鍏夊墲婢规帡鏁?{tool.title || tool.name}`,
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
            content: 'Summarize the agent observations into a clear final answer. Mention limitations and useful next steps when appropriate.'
        },
        {
            role: 'user',
            content: `闁烩晩鍠楅悥锝夋晬?{goal}\n\n闁圭瑳鍡╂斀閻犱焦婢樼紞宥夋晬濮濇樆${JSON.stringify(observations, null, 2)}`
        }
    ];
    const content = await callModelText(modelCfg, messages, { user });
    if (user) recordAgentModelUsage(user, modelCfg, messages, content, 'agent_summary', runId);
    return content || 'No final answer was generated.';
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

// v0.0.49 婵炵繝绀佺槐?function calling 闁告帒妫欓弫?
function isStreamingToolsEnabled() {
    return String(process.env.AGENT_STREAMING_TOOLS || '').toLowerCase() === 'true';
}

// 闁?agent 鐎规悶鍎遍崣鍧楀礆濡ゅ嫨鈧啯娼浣哥亣 OpenAI tools schema闁挎稒绋愮换姘舵偩濞嗗繑鍤掗柛姘С缁?input_schema
// 婵炵繝绀佺槐锟犲礆閸℃ɑ鏆滈柨娑欑婵＄霉娴ｅ摜纭€ tool_calls 闁告绻楅鍛姜椤掍礁鐏?agent 婵縿鍎甸鍐媼閺夎法绉块柨娑欑☉閵囨垹鎷归妷锔筋槯閺夆晜鏌ㄥú?{ completed: false } 閻犱讲鏅涢ˇ鑽や沪閸屾碍绀€闂侇偀鍋?
async function tryRunAgentStreaming({ run, user, modelCfg, toolList, runId, deadline, assertRunWithinBudget, assertRunNotCancelled, observations }) {
    try {
        const tools = buildAgentToolSchemas(toolList);
        const systemPrompt = `You are an agent. Goal: ${run.goal || ''}\n\nUse tool_calls when useful; otherwise provide a final answer. Return structured tool input JSON.`;

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
            // 闁煎搫鍊圭粊锕傛晬?00ms 闁?闁?20 閻庢稒顨堥浣规櫠閻愬搫娅ら柡鍐煐鐢綊鏌呮担椋庮伇婵?snapshot闁挎稑鐭傛导鈺呭礂?SSE 濡炲瀛╁В?
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
            // 婵縿鍎甸鍐磼閹惧瓨灏嗛柟鎭掑妺缁旀潙鈻庨埄鍐╀粯缂備礁鐗嗛幓鈺呮偂?
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

            // 闁?assistant tool_calls 闁告劖鐟ュú鏍ㄥ濮樺磭妯堥柨娑樿嫰閸ｎ垱寰勯崶銊モ挃閻炴稑鑻导鎰板礂?
            conversation.push(buildAssistantToolMessage(result));

            // 濡炪倕鎼花顓㈠箥瑜戦、?tool_calls闁挎稒绋愰幑銏℃媴閺囨氨顏卞☉鎿冧簻娴兼劙宕楀畡鑸杭閻犳劑鍎扮划娑欑┍濠靛牊娈?tool 婵炴垵鐗婃导鍛閵夈倗鈹掓俊顖椻偓宕団偓鐑藉礃閸愯尙鏆板☉鎾愁儎缁旀潙顫?
            for (const call of result.toolCalls) {
                assertRunWithinBudget();
                assertRunNotCancelled(runId);
                const selectedTool = toolList.find(t => t.name === call.name);
                if (!selectedTool) {
                    const message = `鐎规悶鍎遍崣鍧楀嫉椤忓懎鎴块柡澶婂暞閸ㄣ劍绋夊鍛憼闁革富鐓夌槐?{call.name}`;
                    conversation.push(buildToolResultMessage(call.id, { error: message }));
                    insertStep(runId, listSteps(runId).length + 1, {
                        type: 'tool',
                        title: `閻犲搫鐤囩换鍐嫉椤忓棛鍙€鐎规悶鍎遍崣鍧楁晬?{call.name || '-'}`,
                        toolName: call.name || '',
                        input: call.arguments || {},
                        output: { error: message },
                        errorMessage: message,
                        status: 'error'
                    });
                    continue;
                }
                if (maybePauseForApproval(run, selectedTool, call.arguments || {})) {
                    // 鐎规瓕灏～锕傚汲閸屾矮绮荤紒娑橆槸缁剁喓鈧厜鍓濇竟鎺楁晬濞戞瑧銈︾€殿喖绻愰崹搴ㄥ绩椤栫偐鍋撻埀顒勫礄閻氬绀夌紒娑橆槺閺併倝骞嬪畡閭﹀悁闁圭數鎳撻幃妤佸濮樿泛娅㈤柡鍌涙緲閸欏棝姊?
                    return { completed: true };
                }
                const callStart = Date.now();
                try {
                    const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
                    const output = await withTimeout(
                        executeToolByName(call.name, args, user, toolList),
                        Math.min(normalizePositiveInt(run.tool_timeout_ms, AGENT_TOOL_TIMEOUT_MS, 30000, 10 * 60 * 1000), Math.max(deadline - Date.now(), 1000)),
                        `鐎规悶鍎遍崣璺ㄦ嫬閸愵亝鏆?${call.name}`
                    );
                    const compactOutput = clampText(output, 10000);
                    observations.push({ step, tool: call.name, input: args, output: compactOutput });
                    insertStep(runId, listSteps(runId).length + 1, {
                        type: 'tool',
                        title: `閻犲鍟伴弫銈咁啅閵夈儱寰旈柨?{call.name}`,
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
                        title: `鐎规悶鍎遍崣璺ㄦ嫬閸愵亝鏆忓鎯扮簿鐟欙箓鏁?{call.name}`,
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
        // 婵縿鍎查弳鐔兼嚀濡も偓閺佹牗绂掑鍡樺紦閻庣懓鏈崹?闁?閻犱讲鏅涢ˇ鑽や沪閸屾稒锛嬮梺顐ｆ缁额偊宕楀鍐亢闁挎稑鐗嗛幃搴ㄥ箣閹邦厽浠樼紓浣哥墢閻＄喎顩奸崼顒傜
        return { completed: false };
    } catch (streamErr) {
        // 婵炵繝绀佺槐鈩冨緞鏉堫偉袝闁哄啯婀圭粭澶屾媼閳衡偓閹广垽宕濋敍鍕函闁规亽鍎茬€垫洟骞掓径娑氱閻犱焦婢樼紞宥夊触鎼粹剝绀€闂侇偀鍋撻柛鎺斿濡偊宕氶崱妯绘殰
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
                `鐎规悶鍎扮紞鏂棵规担钘壩濋柣?${node.title || node.id}`
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
                    title: `閻犲搫鐤囩换鍐啅閵夈倗绋婃繛缈犳祰婵☆參鎮欓惂鍝ョ獥${node.title}`,
                    toolName: node.tool,
                    input: node.input,
                    output: { status: 'skipped', dependsOn: node.dependsOn }
                });
                stepIndex += 1;
            } else {
                runnable.push(node);
            }
        });

        await Promise.all(runnable.slice(0, 4).map(async node => {
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
                    title: `鐎规悶鍎扮紞鏂棵规担钘壩濋柣鎰嚀閻ｎ剟骞嬮幇鍓佺獥${node.title}`,
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
                    title: policy.onError === 'continue' ? `鐎规悶鍎扮紞鏂棵规担钘壩濋柣鎰嚀閵囨垹鎷归妷銈囩ɑ缂備綀鍛暰闁?{node.title}` : `鐎规悶鍎扮紞鏂棵规担钘壩濋柣鎰嚀閵囨垹鎷归妷顖滅獥${node.title}`,
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
        // 闁?run.model_router 閺夆晜绋栭、鎴炴交閹邦垼鏀介柡鍐煐鑶╅柛銊ヮ儓閻箖鎮介幉瀣耿fixed 缂佹稑顦幃鎾诲籍瑜戦、鎴炵▔?
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
                        title: `婵☆垪鈧磭鈧鎹勯婊勬殸闁?{routerStrategy}`,
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

        // 闁告瑯鍨堕埀顒€顧€缁辨澘霉娴ｅ摜纭€ function calling 闁告帒妫欓弫顕€鏁嶉崸?.0.49闁?
        // 濮掓稒顭堥濠氭偝椤栨凹鏆旈柛娆愶耿閸ｆ椽寮甸鍕；闁告凹鍨卞鍌滄導閻楀牊锛嬮柛銉у仜閹酣宕?JSON 闁告绻楅鍛存晬濞戞ɑ鍎欓柣顫妼閹寰勬潏顐バ曞☉鏃傚枍缁变即鎳涢鍕楅柛銉у仱閳ь兘鍋撻柨娑樺缁绘氨鎷犳担閿嬪床闁告枀銈呭幋閻庣懓鏈崹?
        if (isStreamingToolsEnabled()) {
            const streamingResult = await tryRunAgentStreaming({
                run, user, modelCfg, toolList, runId, deadline, assertRunWithinBudget, assertRunNotCancelled, observations
            });
            if (streamingResult?.completed) return;
            // 闁哄牜浜滈悾顒勫箣閹板墎绀勬繛缈犵缁扁剝寰勬潏顐バ?/ 閻℃帒鎳忛鐐哄极鐢喚绀嗛柛鎺撶懅閹撮绱掗陇娉查柡鍐勫啯绀€闁告艾鐗嗛崺妤€顕ラ鍡楃畾
        }

        for (let step = 1; step <= normalizeMaxSteps(run.max_steps); step += 1) {
            assertRunWithinBudget();
            assertRunNotCancelled(runId);
            updateRun(runId, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
            const plannerMessages = buildPlannerMessages(run.goal, toolList, observations, run.run_mode, parseJsonObject(run.context_config) || {});
            const plannedText = await withTimeout(callModelText(modelCfg, plannerMessages, { user }), Math.min(180000, Math.max(deadline - Date.now(), 1000)), '婵☆垪鈧磭鈧鎲撮崟顐㈢亰');
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
                    `鐎规悶鍎遍崣璺ㄦ嫬閸愵亝鏆?${plan.tool}`
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
                    title: `閻犲鍟伴弫銈咁啅閵夈儱寰旈柨?{plan.tool}`,
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
                    title: `鐎规悶鍎遍崣璺ㄦ嫬閸愵亝鏆忓鎯扮簿鐟欙箓鏁?{plan.tool}`,
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
        // v0.0.50 auto-escalate闁挎稒鐭紞鍡欑磾椤旇绻嗛柡鍐硾瀹曞瞼鐥閸╁矂寮撮弶鎴濈箒婵☆垪鈧磭鈧兘宕樺鍛€ら柟瀛樺姃缁旀潙鈻?
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
                            title: '婵☆垪鈧磭鈧兘宕￠崶鈺呯崜闁挎稒鐡玼to-escalate',
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
                title: `闁煎浜滄慨鈺呮煂瀹ュ牏妲?${retryCount + 1}/${retryLimit}`,
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
            error_message: `闁活潿鍔嶉崺娑㈠箯閹烘梻鍗滈柤瀹犳婵繑鎯旈幘鍏呯矗闁稿繐鍢查鎼佸箥閻у摜绐?{pending.tool || '-'}`,
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
    const cleanGoal = normalizeAgentGoal(goal);
    const modelCfg = getRunnableModelForUser(modelId, user);
    if (!modelCfg) throw new Error('Please choose an accessible model for the agent.');
    const runId = createRunId();
    const now = getBeijingTimestamp();
    const normalizedToolPolicy = normalizeToolPolicy(toolPolicy);
    const normalizedRunMode = normalizeRunMode(runMode);
    const normalizedRouter = normalizeRouterStrategy(modelRouter);
    const runMetadata = metadata && typeof metadata === 'object' ? { ...metadata } : {};
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
