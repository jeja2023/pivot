const { query, queryOne, execute } = require('../../db/client');
const crypto = require('crypto');
const { logger } = require('../../logger');
const { getBeijingTimestamp } = require('../../time');
const { getRunnableModelForUserAsync } = require('../models');
const { clampText, compactToolOutputForModel, executeToolByName, findAgentToolByName } = require('../agent-tool-runtime');
const { runAgentDag, upsertDagNode } = require('../agent-dag-runtime');
const { isStreamingToolsEnabled, tryRunAgentStreaming } = require('../agent-streaming-runtime');
const { createAgentQueue } = require('../agent-queue');
const { callModelText, recordAgentModelUsage } = require('../agent-model');
const { normalizeToolInput } = require('../agent-policy');
const { publishUserEvent } = require('../realtime-events');
const { chooseModel, normalizeStrategy: normalizeRouterStrategy, assessConfidence, pickEscalationModel } = require('../model-router');
const { getModelEndpointRuntimeStatus } = require('../model-runtime');
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
} = require('../agent-schedules');
const {
    configureAgentTriggers,
    createWorkflowTrigger,
    deleteWorkflowTrigger,
    listWorkflowTriggers,
    rotateWorkflowTriggerToken,
    runDuePollingTriggers,
    updateWorkflowTrigger
} = require('../agent-triggers');
const {
    createAgentTemplate,
    deleteAgentTemplate,
    listAgentTemplates,
    updateAgentTemplate,
    assertTemplateAccess
} = require('../agent-templates');
const {
    createAgentWorkflow,
    deleteAgentWorkflow,
    diffAgentWorkflowVersions,
    getAgentWorkflowForUser,
    assertWorkflowLlmNodesConfigured,
    listAgentWorkflowVersions,
    listAgentWorkflows,
    listAgentWorkflowShareOptions,
    normalizeDagInputsPayload,
    publishAgentWorkflowVersion,
    restoreAgentWorkflow,
    resolveAgentWorkflowVersion,
    restoreAgentWorkflowVersion,
    updateAgentWorkflow,
    updateAgentWorkflowMetadata,
    updateAgentWorkflowSharing
} = require('../agent-workflows');
const {
    getRunDetailForUser: getRunDetailForUserHelper,
    getRunForUser,
    listDagNodes,
    listSteps
} = require('../agent-runs');
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
} = require('../agent-artifacts');
const { formatToolList } = require('../agent-tool-catalog');
const {
    assertAgentWorkflowDependencies,
    resolveAgentWorkflowDependencyBindings
} = require('../agent-workflow-dependencies');
const {
    getAgentMetrics,
    getAgentRuntimeStatus: buildAgentRuntimeStatus
} = require('../agent-monitoring');
const {
    ACTIVE_STATUSES,
    parseJsonObject,
    normalizeMaxSteps,
    resolveMaxSteps,
    normalizePriority,
    normalizeRunMode,
    normalizeToolPolicy,
    normalizeApprovalPolicy,
    normalizePositiveInt,
    serializeContextConfig,
    normalizeDagSpec,
    normalizeToolAllowlist,
    serializeToolAllowlist,
    normalizeAgentGoal,
    normalizeAgentTitle
} = require('../agent-validators');
const {
    AGENT_DEFAULT_TIMEOUT_MS,
    AGENT_TOOL_TIMEOUT_MS,
    AGENT_STALE_RUNNING_MINUTES,
    AGENT_QUEUE_LOCK_MS,
    AGENT_INSTANCE_ID,
    getAgentMaxConcurrentRuns,
    getAgentDagNodeConcurrency,
    createRunId,
    withTimeout
} = require('./runtime-env');
const { getAgentRunTitle, getRunMetadata } = require('./metadata');
const { assertAgentRunStatusTransition, canTransitionAgentRunStatus, TERMINAL_STATUSES } = require('./state-machine');
const {
    ensureAgentTrace,
    finishAgentTraceSpan,
    recordAgentTraceSpan,
    startAgentTraceSpan,
    syncAgentTraceFromRun
} = require('../agent-traces');
const { buildAgentResumeContext, recordAgentCheckpoint } = require('../agent-checkpoints');
const { getAgentSkillExecutionContext } = require('../agent-skills');
const { TaskBudget, normalizeTaskBudget } = require('../agent-budget');
const { diagnoseError } = require('../agent-diagnosis');
const { recordAgentToolCall } = require('../agent-tool-audit');
const { createPersistedAgentStepContext } = require('../agent-world-state-store');
const { recordAgentEvent } = require('../agent-event-log');
const { claimAgentControlMessages } = require('../agent-control');
const {
    buildForkHistory,
    cancelChildRunReservation,
    initializeAgentRunResources,
    normalizeForkHistory,
    releaseChildRunReservation,
    reserveChildRunResources
} = require('../agent-run-resources');
const {
    configureAgentApprovalRequests,
    runApprovalTimeouts,
    waitForWorkflowApproval,
    waitForWorkflowDelay
} = require('../agent-approval-requests');

const { buildPlannerMessages, synthesizeFinalAnswer, isMissingFinalAnswer } = require('./planner');
const { inferDagRunGoal } = require('./dag-run-config');
const { createAgentNotificationFactory } = require('./notifications');
const { createApprovalHelpers } = require('./approvals');
const { buildVisionHistory, limitVisionImages } = require('../chat-vision');
const {
    persistAgentRunChatResult,
    recoverChatAgentResults
} = require('../chat-agent-bridge');


let agentQueue = null;
const activeRunControllers = new Map();
const taskBudgetsBySignal = new WeakMap();
let agentRecoveryTimer = null;
const createAgentNotification = createAgentNotificationFactory({
    getTimestamp: getBeijingTimestamp,
    publishUserEvent
});
const { approvalInputHash, isApprovalGranted, shouldPauseForApproval, maybePauseForApproval } = createApprovalHelpers({
    getRunMetadata,
    normalizeApprovalPolicy,
    getTimestamp: getBeijingTimestamp,
    setRunMetadata,
    updateRun,
    insertStep,
    listSteps,
    createAgentNotification,
    recordAgentEvent
});



async function updateRun(runId, fields = {}, maxRetries = 3) {
    const allowed = [
        'status', 'final_answer', 'error_message', 'completed_at', 'updated_at', 'title',
        'cancelled_at', 'deleted_at', 'deleted_by_user', 'delete_reason', 'started_at',
        'last_heartbeat_at', 'priority', 'run_mode', 'tool_policy', 'tool_allowlist',
        'approval_policy', 'timeout_ms', 'tool_timeout_ms', 'retry_limit', 'retry_count',
        'max_token_budget', 'export_count', 'template_id', 'schedule_id', 'context_config',
        'resume_from_step', 'metadata', 'locked_by', 'lock_expires_at',
        'input_tokens', 'output_tokens', 'total_tokens', 'budget_config', 'usage_stats', 'network_policy'
    ];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    if (entries.length === 0) return 0;
    const statusEntry = entries.find(([key]) => key === 'status');
    const targetStatus = statusEntry ? statusEntry[1] : null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        let currentStatus = '';
        if (statusEntry) {
            const row = await queryOne('SELECT status FROM agent_runs WHERE id = ?', [runId]);
            currentStatus = row?.status || '';
            assertAgentRunStatusTransition(currentStatus, targetStatus, { runId });
        }
        const set = entries.map(([key]) => `${key} = ?`).join(', ');
        const where = statusEntry ? 'WHERE id = ? AND status = ?' : 'WHERE id = ?';
        const params = [...entries.map(([, value]) => value), runId];
        if (statusEntry) params.push(currentStatus);
        const changes = await execute(`UPDATE agent_runs SET ${set} ${where}`, params);
        if (changes > 0) {
            if (entries.some(([key]) => [
                'status',
                'final_answer',
                'error_message',
                'completed_at',
                'cancelled_at',
                'deleted_at',
                'last_heartbeat_at'
            ].includes(key))) {
                await publishAgentRunEvent(runId, 'updated');
            }
            if (statusEntry) {
                try {
                    await recordAgentEvent({
                        runId,
                        type: ['approval_required', 'waiting_approval', 'awaiting_approval'].includes(targetStatus)
                            ? 'run.paused'
                            : ['resuming'].includes(targetStatus)
                                ? 'run.resumed'
                                : ['completed', 'completed_with_errors', 'error', 'failed', 'cancelled'].includes(targetStatus)
                                    ? 'run.completed'
                                    : 'run.status_changed',
                        payload: { from: currentStatus, to: targetStatus },
                        eventKey: `status:${currentStatus}->${targetStatus}`
                    });
                } catch (eventError) {
                    logger.warn({ runId, err: eventError.message }, 'Agent 状态事件写入失败');
                }
                if (TERMINAL_STATUSES.has(targetStatus)) {
                    try { await releaseChildRunReservation(runId); } catch (resourceError) {
                        logger.warn({ runId, err: resourceError.message }, 'Agent 子运行资源预留释放失败');
                    }
                    try {
                        await persistAgentRunChatResult(runId);
                    } catch (chatBridgeError) {
                        logger.error({ runId, err: chatBridgeError.message }, 'Agent 聊天结果回写失败');
                    }
                }
            }
            return changes;
        }
        if (!statusEntry) return 0;

        const row = await queryOne('SELECT status FROM agent_runs WHERE id = ?', [runId]);
        const latestStatus = row?.status || '';
        if (latestStatus === targetStatus) {
            return 1;
        }
        if (!canTransitionAgentRunStatus(latestStatus, targetStatus)) {
            const error = new Error(`Agent run status changed concurrently: ${currentStatus || '<missing>'} -> ${latestStatus || '<missing>'}`);
            error.code = 'AGENT_STATUS_CONFLICT';
            error.runId = runId;
            throw error;
        }
    }
    return 0;
}

async function updateRunCas(runId, expectedStatuses = [], fields = {}) {
    const allowedStatuses = [...new Set((Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses])
        .map(value => String(value || '').trim())
        .filter(Boolean))];
    if (!allowedStatuses.length) return 0;
    const row = await queryOne('SELECT status FROM agent_runs WHERE id = ?', [runId]);
    const currentStatus = row?.status || '';
    if (!allowedStatuses.includes(currentStatus)) return 0;
    if (fields.status) assertAgentRunStatusTransition(currentStatus, fields.status, { runId });
    const allowed = [
        'status', 'final_answer', 'error_message', 'completed_at', 'updated_at', 'title',
        'cancelled_at', 'deleted_at', 'deleted_by_user', 'delete_reason', 'started_at',
        'last_heartbeat_at', 'priority', 'run_mode', 'tool_policy', 'tool_allowlist',
        'approval_policy', 'timeout_ms', 'tool_timeout_ms', 'retry_limit', 'retry_count',
        'max_token_budget', 'export_count', 'template_id', 'schedule_id', 'context_config',
        'resume_from_step', 'metadata', 'locked_by', 'lock_expires_at',
        'input_tokens', 'output_tokens', 'total_tokens', 'budget_config', 'usage_stats', 'network_policy'
    ];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    if (!entries.length) return 0;
    const placeholders = allowedStatuses.map(() => '?').join(', ');
    const set = entries.map(([key]) => `${key} = ?`).join(', ');
    const changes = await execute(`UPDATE agent_runs SET ${set} WHERE id = ? AND status IN (${placeholders})`,
        [...entries.map(([, value]) => value), runId, ...allowedStatuses]);
    if (changes) await publishAgentRunEvent(runId, 'updated');
    return changes;
}

async function publishAgentRunEvent(runId, reason = 'updated', extra = {}) {
    const run = await queryOne(`
        SELECT id, user_id, title, goal, status, updated_at, started_at, completed_at, last_heartbeat_at, error_message
        FROM agent_runs
        WHERE id = ?
    `, [runId]);
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

async function getRunStatus(runId) {
    const row = await queryOne('SELECT status FROM agent_runs WHERE id = ?', [runId]);
    return row?.status || '';
}

async function getRunUser(runId) {
    return await queryOne("SELECT u.id, COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username, u.nickname, u.unit, u.role FROM agent_runs r JOIN users u ON u.id = r.user_id WHERE r.id = ? AND COALESCE(u.status, 'active') != 'disabled' AND u.deleted_at IS NULL", [runId]);
}

async function assertRunUserActive(user) {
    const active = await queryOne("SELECT id FROM users WHERE id = ? AND COALESCE(status, 'active') != 'disabled' AND deleted_at IS NULL", [user?.id]);
    if (!active) {
        const err = new Error('任务所属账号已被禁用或删除。');
        err.code = 'AGENT_USER_REVOKED';
        throw err;
    }
}

async function markRunError(runId, message) {
    await updateRun(runId, {
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
            logger,
            instanceId: AGENT_INSTANCE_ID,
            maxConcurrent: getAgentMaxConcurrentRuns(),
            maxConcurrentPerUser: Math.max(Number.parseInt(process.env.AGENT_MAX_CONCURRENT_PER_USER || '2', 10) || 2, 1),
            lockMs: AGENT_QUEUE_LOCK_MS,
            getRunUser,
            runAgent,
            markRunError,
            getTimestamp: getBeijingTimestamp
        });
    }
    return agentQueue;
}

async function setRunMetadata(runId, patch = {}) {
    const row = (await queryOne('SELECT metadata FROM agent_runs WHERE id = ?', [runId])) || {};
    const current = parseJsonObject(row.metadata) || {};
    await updateRun(runId, { metadata: JSON.stringify({ ...current, ...patch }), updated_at: getBeijingTimestamp() });
}

function stableWorkflowDelayKey(toolName, _step, input = {}) {
    const hash = crypto.createHash('sha256')
        .update(JSON.stringify(input || {}))
        .digest('hex')
        .slice(0, 16);
    return `${toolName}:standard:${hash}`;
}

async function appendRunMetadataList(runId, key, item, limit = 20) {
    const row = (await queryOne('SELECT metadata FROM agent_runs WHERE id = ?', [runId])) || {};
    const current = parseJsonObject(row.metadata) || {};
    const list = Array.isArray(current[key]) ? current[key].slice(-(limit - 1)) : [];
    list.push(item);
    await updateRun(runId, { metadata: JSON.stringify({ ...current, [key]: list }), updated_at: getBeijingTimestamp() });
}

async function recordRunRetryReason(runId, input = {}) {
    await appendRunMetadataList(runId, 'retryReasons', {
        at: getBeijingTimestamp(),
        attempt: input.attempt || null,
        limit: input.limit || null,
        code: input.code || '',
        reason: input.reason || input.error || 'unknown_error'
    });
}

function isRunCancelled(runId) {
    return activeRunControllers.get(runId)?.signal?.aborted === true;
}

function assertRunNotCancelled(runId) {
    if (isRunCancelled(runId)) {
        const err = new Error('任务已停止。');
        err.code = 'AGENT_RUN_CANCELLED';
        throw err;
    }
}

async function cancelAgentRun(runId, user) {
    const run = await getRunForUser(runId, user);
    if (!run) return null;
    if (!ACTIVE_STATUSES.has(run.status)) return run;
    const now = getBeijingTimestamp();
    await updateRun(runId, {
        status: 'cancelled',
        error_message: '智能体运行已被用户主动取消。',
        cancelled_at: now,
        completed_at: now,
        updated_at: now
    });
    // Parent cancellation propagates through the persisted Agent tree so a
    // child cannot continue consuming tools after its supervisor has stopped.
    const childRuns = await query(`
        SELECT id
        FROM agent_runs
        WHERE parent_run_id = ?
          AND user_id = ?
          AND status IN ('queued', 'running', 'planning', 'executing', 'observing', 'diagnosing', 'replanning', 'resuming', 'approval_required', 'awaiting_approval', 'waiting_approval')
          AND deleted_at IS NULL
    `, [runId, user.id]);
    for (const child of childRuns) {
        await cancelAgentRun(child.id, user);
    }
    const abortError = new Error('智能体运行已被用户主动取消。');
    abortError.code = 'AGENT_RUN_CANCELLED';
    activeRunControllers.get(runId)?.abort(abortError);
    const steps = await listSteps(runId);
    await insertStep(runId, (steps || []).length + 1, {
        type: 'control',
        title: '用户主动取消运行',
        output: { status: 'cancelled' }
    });
    await createAgentNotification(user.id, runId, 'cancelled', '任务运行已停止', getAgentRunTitle(run));
    return await getRunForUser(runId, user);
}

async function createChildRunFromExisting(run, user) {
    const metadata = getRunMetadata(run);
    return await createAgentRun({
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
        budgetConfig: parseJsonObject(run.budget_config) || {},
        networkPolicy: parseJsonObject(run.network_policy) || {},
        templateId: run.template_id,
        scheduleId: run.schedule_id,
        contextConfig: parseJsonObject(run.context_config) || {},
        parentRunId: run.id,
        metadata,
        forkHistory: metadata.forkHistory || metadata.fork_history || 'none',
        dagSpec: metadata.dagSpec
    });
}

async function rerunAgentRun(runId, user) {
    const run = await getRunForUser(runId, user);
    if (!run) return null;
    if (ACTIVE_STATUSES.has(run.status)) {
        const err = new Error('当前任务仍在执行中，请停止或等待结束后再重新运行。');
        err.status = 400;
        throw err;
    }
    return await createChildRunFromExisting(run, user);
}

async function buildDagResumeSpec(originalRun, startNodeId = '') {
    const metadata = getRunMetadata(originalRun);
    const dagSpec = normalizeDagSpec(metadata.dagSpec || metadata.dag || {});
    if (!dagSpec.nodes.length) return null;
    const dagNodes = await listDagNodes(originalRun.id);
    const failed = (dagNodes || []).filter(node => node.status === 'error');
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
    (dagNodes || []).forEach(node => {
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
    const layout = Object.fromEntries(nodes
        .filter(node => dagSpec.layout?.[node.id])
        .map(node => [node.id, dagSpec.layout[node.id]]));
    return { dagSpec: { nodes, layout }, reusable };
}

async function rerunAgentDagFromNode(runId, user, nodeId = '') {
    const run = await getRunForUser(runId, user);
    if (!run) return null;
    if (ACTIVE_STATUSES.has(run.status)) {
        const err = new Error('当前任务仍在执行中，请停止或等待结束后再重跑节点。');
        err.status = 400;
        throw err;
    }
    if (run.run_mode !== 'dag') {
        const err = new Error('只有工作流任务可以从节点重新运行。');
        err.status = 400;
        throw err;
    }
    const resume = await buildDagResumeSpec(run, nodeId);
    if (!resume || !resume.dagSpec.nodes.length) {
        const err = new Error('没有找到可重用的工作流节点。');
        err.status = 400;
        throw err;
    }
    const metadata = getRunMetadata(run);
    return await createAgentRun({
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
        budgetConfig: parseJsonObject(run.budget_config) || {},
        networkPolicy: parseJsonObject(run.network_policy) || {},
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
        forkHistory: metadata.forkHistory || metadata.fork_history || 'none',
        dagSpec: resume.dagSpec
    });
}

async function resumeAgentRun(runId, user) {
    const run = await getRunForUser(runId, user);
    if (!run) return null;
    if (ACTIVE_STATUSES.has(run.status) || run.status === 'approval_required') {
        const err = new Error('当前任务仍在执行中，无需断点续跑。');
        err.status = 400;
        throw err;
    }
    if (run.run_mode === 'dag') {
        const dagResume = await buildDagResumeSpec(run);
        if (dagResume?.dagSpec?.nodes?.length) return await rerunAgentDagFromNode(runId, user, '');
    }
    const steps = await listSteps(run.id);
    const lastStep = (steps || []).length ? Math.max(...steps.map(step => Number(step.step_index || 0))) : 0;
    const failed = (steps || []).filter(step => step.status === 'error').slice(-3);
    const resumeContext = await buildAgentResumeContext(run.id);
    const previousMetadata = getRunMetadata(run);
    return await createAgentRun({
        user,
        goal: run.goal,
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
        budgetConfig: parseJsonObject(run.budget_config) || {},
        networkPolicy: parseJsonObject(run.network_policy) || {},
        templateId: run.template_id,
        scheduleId: run.schedule_id,
        contextConfig: parseJsonObject(run.context_config) || {},
        resumeFromStep: lastStep,
        parentRunId: run.id,
        metadata: {
            ...previousMetadata,
            pendingApproval: null,
            resumedFromRunId: run.id,
            failedSteps: failed.map(step => step.id),
            resumeContext: {
                ...resumeContext,
                previousStatus: run.status,
                previousAnswer: clampText(run.final_answer || '', 1200),
                previousError: run.error_message || ''
            }
        },
        forkHistory: previousMetadata.forkHistory || previousMetadata.fork_history || 'none'
    });
}

async function softDeleteAgentRun(runId, user, reason = '') {
    const run = await getRunForUser(runId, user);
    if (!run) return null;
    if (ACTIVE_STATUSES.has(run.status)) {
        const err = new Error('正在执行的任务不能删除。');
        err.status = 400;
        throw err;
    }
    const now = getBeijingTimestamp();
    await updateRun(runId, {
        deleted_at: now,
        deleted_by_user: user.id,
        delete_reason: String(reason || '').trim().slice(0, 500),
        updated_at: now
    });
    await insertStep(runId, (await listSteps(runId)).length + 1, {
        type: 'control',
        title: '任务记录已移除',
        output: {
            status: 'deleted',
            deletedAt: now,
            deletedBy: user.username || user.id
        }
    });
    return await getRunForUser(runId, user, { includeDeleted: true });
}

async function insertStep(runId, stepIndex, data = {}) {
    const now = getBeijingTimestamp();
    let safeStepIndex = Number.isInteger(stepIndex) && stepIndex > 0 ? stepIndex : null;
    if (safeStepIndex === null) {
        const row = await queryOne('SELECT COALESCE(MAX(step_index), 0) + 1 AS next_index FROM agent_steps WHERE run_id = ?', [runId]);
        safeStepIndex = row?.next_index || 1;
    }
    const changes = await execute(`
        INSERT INTO agent_steps (
            run_id, step_index, type, title, tool_name, input, output, error_message,
            status, duration_ms, started_at, completed_at, created_at, context_hash
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        runId,
        safeStepIndex,
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
        now,
        String(data.contextHash || '').slice(0, 64)
    ]);
    if (changes > 0) {
        await recordAgentCheckpoint(runId, {
            stepIndex: safeStepIndex,
            type: data.type || 'control',
            status: data.status || 'completed',
            state: {
                title: data.title || '',
                toolName: data.toolName || '',
                nodeId: data.nodeId || '',
                input: data.input,
                output: data.output,
                errorMessage: data.errorMessage || '',
                durationMs: Number(data.durationMs) || 0
            },
            createdAt: data.completedAt || now
        });
        await recordAgentTraceSpan(runId, {
            type: data.type || 'note',
            name: data.title || `执行步骤 ${safeStepIndex}`,
            input: data.input,
            output: data.output,
            details: { stepIndex: safeStepIndex, toolName: data.toolName || '' },
            contextHash: data.contextHash || '',
            status: data.status === 'error' ? 'error' : (data.status || 'completed'),
            errorMessage: data.errorMessage || '',
            durationMs: Number(data.durationMs) || 0,
            startedAt: data.startedAt || now,
            completedAt: data.completedAt || now
        });
        await publishAgentRunEvent(runId, 'step', {
            step: {
                stepIndex: safeStepIndex,
                type: data.type || 'note',
                status: data.status || 'success',
                title: data.title || ''
            }
        });
        try {
            await recordAgentEvent({
                runId,
                type: 'step.recorded',
                stepIndex: safeStepIndex,
                payload: {
                    type: data.type || 'note',
                    status: data.status || 'success',
                    title: data.title || '',
                    toolName: data.toolName || '',
                    contextHash: data.contextHash || ''
                },
                eventKey: `step:${safeStepIndex}:${data.type || 'note'}`
            });
        } catch (eventError) {
            logger.warn({ runId, err: eventError.message }, 'Agent 步骤事件写入失败');
        }
    }
}

function getAgentRuntimeDeps(signal = null, taskBudget = null) {
    const effectiveTaskBudget = taskBudget || taskBudgetsBySignal.get(signal) || null;
    return {
        agentToolTimeoutMs: AGENT_TOOL_TIMEOUT_MS,
        dagNodeConcurrency: getAgentDagNodeConcurrency(),
        logger,
        assertRunNotCancelled,
        createAgentNotification,
        getAgentRunTitle,
        getRunMetadata,
        isApprovalGranted,
        insertStep,
        isMissingFinalAnswer,
        listSteps,
        maybePauseForApproval,
        parseJsonObject,
        publishUserEvent,
        waitForWorkflowApproval,
        waitForWorkflowDelay,
        synthesizeFinalAnswer,
        finishAgentTraceSpan,
        startAgentTraceSpan,
        updateRun,
        withTimeout,
        signal,
        taskBudget: effectiveTaskBudget,
        captureStepContext: options => createPersistedAgentStepContext(options),
        recordAgentEvent,
        pollAgentControlMessages: (runId, user, options) => claimAgentControlMessages(runId, user, options)
    };
}

async function runAgent(runId, user) {
    const runController = new AbortController();
    activeRunControllers.set(runId, runController);
    let deadlineTimer = null;
    let taskBudget = null;
    try {
        await assertRunUserActive(user);
        const run = await getRunForUser(runId, user, { includeDeleted: true });
        if (!run) throw new Error('任务不存在。');
        if (run.deleted_at || TERMINAL_STATUSES.has(run.status)) return;
        await ensureAgentTrace(run, {
            runMode: run.run_mode,
            modelRouter: run.model_router,
            approvalPolicy: run.approval_policy
        });
        assertRunNotCancelled(runId);
        const deadline = Date.now() + normalizePositiveInt(run.timeout_ms, AGENT_DEFAULT_TIMEOUT_MS, 60000, 24 * 60 * 60 * 1000);
        const budgetConfig = parseJsonObject(run.budget_config) || {};
        taskBudget = new TaskBudget(normalizeTaskBudget(budgetConfig), {
            startedAt: Date.now(),
            enabled: true
        });
        taskBudgetsBySignal.set(runController.signal, taskBudget);
        deadlineTimer = setTimeout(() => {
            const error = new Error('智能体运行超时。');
            error.code = 'AGENT_TIMEOUT';
            runController.abort(error);
        }, Math.max(deadline - Date.now(), 1));
        deadlineTimer.unref?.();
        const assertRunWithinBudget = () => {
            if (Date.now() > deadline) {
                const err = new Error('任务执行超时。');
                err.code = 'AGENT_TIMEOUT';
                throw err;
            }
            taskBudget.assertWithin();
        };
        const dagRun = normalizeRunMode(run.run_mode) === 'dag';
        const initialModelCfg = await getRunnableModelForUserAsync(run.model_id, user);
        if (!initialModelCfg && !dagRun) throw new Error('当前智能体运行无可用的模型端点。');
        // run.model_router 控制初始模型是固定使用、预先路由，还是后续升级。
        let modelCfg = initialModelCfg;
        const routerStrategy = normalizeRouterStrategy(run.model_router);
        if (initialModelCfg && routerStrategy !== 'fixed') {
            try {
                const routed = await chooseModel({
                    user,
                    strategy: routerStrategy,
                    hintModelId: run.model_id,
                    messages: [{ role: 'user', content: run.goal || '' }],
                    endpointStatusGetter: getModelEndpointRuntimeStatus
                });
                if (routed && routed.model && routed.model.id !== initialModelCfg.id) {
                    modelCfg = routed.model;
                    await execute('UPDATE agent_runs SET chosen_model_id = ?, updated_at = ? WHERE id = ?', [
                        modelCfg.id, getBeijingTimestamp(), runId
                    ]);
                    await insertStep(runId, (await listSteps(runId)).length + 1, {
                        type: 'control',
                        title: `模型路由选择：${routerStrategy}`,
                        output: { strategy: routerStrategy, chosenModelId: modelCfg.id, chosenModelName: modelCfg.name || modelCfg.model_name || '', reason: routed.reason || '', candidatesCount: routed.candidatesCount || 0 }
                    });
                    logger.info({ runId, strategy: routerStrategy, originalModelId: initialModelCfg.id, chosenModelId: modelCfg.id, reason: routed.reason }, '智能体模型路由已选择模型');
                }
                await recordAgentTraceSpan(runId, {
                    type: 'routing',
                    name: '模型路由',
                    input: { strategy: routerStrategy, requestedModelId: initialModelCfg.id },
                    output: { chosenModelId: modelCfg.id, chosenModelName: modelCfg.name || modelCfg.model_name || '' },
                    details: { strategy: routerStrategy }
                });
            } catch (routerErr) {
                await recordAgentTraceSpan(runId, {
                    type: 'routing',
                    name: '模型路由',
                    input: { strategy: routerStrategy, requestedModelId: initialModelCfg.id },
                    status: 'error',
                    errorMessage: routerErr.message
                });
                logger.warn({ runId, err: routerErr.message }, '智能体模型路由失败，已使用原始模型');
            }
        }

        const runtimeMetadata = getRunMetadata(run);
        let plannerChatHistory = Array.isArray(runtimeMetadata.chatHistory) ? runtimeMetadata.chatHistory : [];
        let plannerCurrentMessage = runtimeMetadata.chatBridge?.currentMessage || null;
        if (runtimeMetadata.chatBridge && run.session_id && user?.id) {
            try {
                const sourceMessages = [
                    ...plannerChatHistory,
                    ...(plannerCurrentMessage ? [plannerCurrentMessage] : [])
                ];
                const visionMessages = limitVisionImages(await buildVisionHistory(
                    sourceMessages,
                    'http://pivot-agent.local',
                    user.id,
                    run.session_id
                ));
                if (plannerCurrentMessage) plannerCurrentMessage = visionMessages.pop() || plannerCurrentMessage;
                plannerChatHistory = visionMessages;
            } catch (error) {
                logger.warn({ runId, err: error.message }, '普通聊天 Agent 图片上下文转换失败，已使用文本上下文');
            }
        }
        const resumeContext = runtimeMetadata.resumeContext && typeof runtimeMetadata.resumeContext === 'object'
            ? runtimeMetadata.resumeContext
            : {};
        const observations = [
            ...(Array.isArray(resumeContext.observations) ? resumeContext.observations : []),
            ...(Array.isArray(resumeContext.recentFailures) ? resumeContext.recentFailures : [])
        ].slice(-25);
        if (resumeContext.latestCheckpointId) {
            await insertStep(runId, (await listSteps(runId)).length + 1, {
                type: 'control',
                title: '已从持久化检查点恢复上下文',
                output: {
                    sourceRunId: resumeContext.sourceRunId || '',
                    checkpointId: resumeContext.latestCheckpointId,
                    restoredObservations: observations.length
                }
            });
        }
        let toolList = await formatToolList(user, {
            toolPolicy: run.tool_policy,
            toolAllowlist: run.tool_allowlist
        });
        const chatBridge = runtimeMetadata.chatBridge;
        const plannerChatContext = chatBridge
            ? { chatHistory: plannerChatHistory, chatAgent: { ...chatBridge, currentMessage: plannerCurrentMessage } }
            : {};
        if (chatBridge && chatBridge.mcpEnabled === true && Array.isArray(chatBridge.mcpToolAllowlist)) {
            const allowedMcpTools = new Set(chatBridge.mcpToolAllowlist.map(value => String(value || '').trim()).filter(Boolean));
            toolList = toolList.map(tool => {
                if (tool?.source !== 'mcp') return tool;
                if (allowedMcpTools.has(String(tool?.name || '').trim())) return tool;
                if (!tool?.databaseTool || !Array.isArray(tool.databaseConnections)) return null;
                const allowedConnections = tool.databaseConnections.filter(connection => allowedMcpTools.has(String(connection?.fullName || '').trim()));
                return allowedConnections.length ? { ...tool, databaseConnections: allowedConnections } : null;
            }).filter(Boolean);
        }
        if (chatBridge && chatBridge.ragEnabled !== true) {
            toolList = toolList.filter(tool => !['rag.search', 'knowledge.list', 'knowledge.graph.query'].includes(String(tool?.name || '')));
        }
        if (runtimeMetadata.chatBridge && runtimeMetadata.chatBridge.mcpEnabled !== true) {
            toolList = toolList.filter(tool => !tool?.network
                && !tool?.side_effect
                && !tool?.approval_required
                && !tool?.requiresApproval
                && !tool?.alwaysRequiresApproval);
        }
        if (toolList.length === 0) {
            throw new Error('没有可用工具符合当前任务配置。');
        }
        assertRunNotCancelled(runId);
        const startedAt = getBeijingTimestamp();
        await updateRun(runId, {
            status: 'planning',
            started_at: run.started_at || startedAt,
            last_heartbeat_at: startedAt,
            updated_at: startedAt
        });

        if (dagRun) {
            await updateRun(runId, { status: 'executing', updated_at: getBeijingTimestamp() });
            await runAgentDag({ run, user, modelCfg, toolList, deadline, assertRunWithinBudget }, getAgentRuntimeDeps(runController.signal));
            return;
        }

        // 启用时优先使用流式函数调用，让模型可直接发出 tool_calls。
        // 如果流式调用未完成，下方 JSON 规划器会基于已收集的观察继续执行。
        const maxSteps = normalizeMaxSteps(run.max_steps, run.run_mode);
        let roundsUsed = 0;
        if (isStreamingToolsEnabled()) {
            const streamingDeps = getAgentRuntimeDeps(runController.signal, taskBudget);
            if (chatBridge) {
                streamingDeps.synthesizeFinalAnswer = (streamModelCfg, streamGoal, streamObservations, streamUser, streamRunId, options = {}) => (
                    synthesizeFinalAnswer(streamModelCfg, streamGoal, streamObservations, streamUser, streamRunId, {
                        ...options,
                        ...plannerChatContext
                    })
                );
            }
            const streamingResult = await tryRunAgentStreaming({
                run,
                user,
                modelCfg,
                toolList,
                runId,
                deadline,
                assertRunWithinBudget,
                assertRunNotCancelled,
                observations,
                chatContext: plannerChatContext
            }, streamingDeps);
            if (streamingResult?.completed) return;
            roundsUsed = Math.min(Math.max(Number(streamingResult?.roundsUsed || 0), 0), maxSteps);
            // 流式调用已产生部分工作但未完成，继续走 JSON 规划器路径。
        }

        let previousWorldState = null;
        for (let step = roundsUsed + 1; step <= maxSteps; step += 1) {
            taskBudget.consumeStep();
            await updateRun(runId, { status: 'planning', updated_at: getBeijingTimestamp() });
            assertRunWithinBudget();
            assertRunNotCancelled(runId);
            await updateRun(runId, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
            const controlMessages = await claimAgentControlMessages(runId, user, { limit: 20 });
            if (controlMessages.length) {
                observations.push(...controlMessages.map(message => ({
                    type: 'agent_control',
                    messageId: message.message_id,
                    messageType: message.message_type,
                    fromRunId: message.from_run_id || '',
                    payload: message.payload
                })));
            }
            const stepContext = await createPersistedAgentStepContext({
                run,
                user,
                turnId: `${runId}:turn:${step}`,
                stepIndex: step,
                modelCfg,
                toolList,
                previousWorldState,
                // JSON planner 每轮重新构造独立消息，必须携带完整 WorldState，不能依赖上一次 Provider 请求的上下文。
                forceWorldStateFull: true,
                fullRefreshReason: 'provider_independent',
                contextConfig: parseJsonObject(run.context_config) || {},
                resumeContext,
                policy: {
                    toolPolicy: run.tool_policy,
                    toolAllowlist: run.tool_allowlist,
                    approvalPolicy: run.approval_policy,
                    networkPolicy: run.network_policy
                },
                approval: { grantedTools: getRunMetadata(run).approvedTools || [] },
                deadline,
                signal: runController.signal
            });
            previousWorldState = stepContext.worldState;
            try {
                await recordAgentEvent({
                    runId,
                    userId: user.id,
                    turnId: stepContext.turnId,
                    stepIndex: step,
                    type: 'step.context_captured',
                    payload: {
                        contextHash: stepContext.contextHash,
                        worldStateHash: stepContext.worldStateHash,
                        worldStateMode: stepContext.worldStateInjection.mode,
                        previousWorldStateHash: stepContext.previousWorldStateHash,
                        contextWindow: stepContext.worldStateWindow || {}
                    },
                    eventKey: stepContext.contextHash
                });
            } catch (eventError) {
                logger.warn({ runId, err: eventError.message }, 'Agent StepContext 事件写入失败');
            }
            const plannerContextConfig = {
                ...(parseJsonObject(run.context_config) || {}),
                chatHistory: plannerChatHistory,
                chatAgent: runtimeMetadata.chatBridge
                    ? { ...runtimeMetadata.chatBridge, currentMessage: plannerCurrentMessage }
                    : null
            };
            const plannerMessages = buildPlannerMessages(run.goal, toolList, observations, run.run_mode, plannerContextConfig, modelCfg, stepContext.worldState, stepContext.worldStateInjection);
            const plannerStartedAt = Date.now();
            const plannerSpanId = await startAgentTraceSpan(runId, {
                type: 'model',
                name: `规划模型调用 #${step}`,
                input: { messageCount: plannerMessages.length, model: modelCfg.name || modelCfg.model_name || modelCfg.id },
                details: { purpose: 'agent_planner', step },
                contextHash: stepContext.contextHash
            });
            let plannedText;
            let plannedTextUsageRef = null;
            try {
                try {
                    await recordAgentEvent({
                        runId,
                        userId: user.id,
                        turnId: stepContext.turnId,
                        stepIndex: step,
                        type: 'model.requested',
                        payload: { purpose: 'agent_planner', messageCount: plannerMessages.length, contextHash: stepContext.contextHash },
                        eventKey: `model:${stepContext.contextHash}:requested`
                    });
                } catch (_) {}
                const usageRef = {};
                plannedText = await withTimeout(signal => callModelText(modelCfg, plannerMessages, { user, signal, usageRef }), Math.min(180000, Math.max(deadline - Date.now(), 1000)), '智能体规划', { signal: runController.signal });
                plannedTextUsageRef = usageRef;
                try {
                    await recordAgentEvent({
                        runId,
                        userId: user.id,
                        turnId: stepContext.turnId,
                        stepIndex: step,
                        type: 'model.completed',
                        payload: { purpose: 'agent_planner', responseLength: String(plannedText || '').length, contextHash: stepContext.contextHash },
                        eventKey: `model:${stepContext.contextHash}:completed`
                    });
                } catch (_) {}
                await finishAgentTraceSpan(plannerSpanId, {
                    output: { responseLength: String(plannedText || '').length },
                    durationMs: Date.now() - plannerStartedAt,
                    contextHash: stepContext.contextHash
                });
            } catch (plannerError) {
                try {
                    await recordAgentEvent({
                        runId,
                        userId: user.id,
                        turnId: stepContext.turnId,
                        stepIndex: step,
                        type: 'model.failed',
                        payload: { purpose: 'agent_planner', errorCode: plannerError.code || '', errorMessage: plannerError.message, contextHash: stepContext.contextHash },
                        eventKey: `model:${stepContext.contextHash}:failed`
                    });
                } catch (_) {}
                await finishAgentTraceSpan(plannerSpanId, {
                    status: 'error',
                    errorMessage: plannerError.message,
                    durationMs: Date.now() - plannerStartedAt,
                    contextHash: stepContext.contextHash
                });
                throw plannerError;
            }
            await recordAgentModelUsage(user, modelCfg, plannerMessages, plannedText, 'agent_planner', runId, { budget: taskBudget, usageRef: plannedTextUsageRef });
            assertRunWithinBudget();
            assertRunNotCancelled(runId);
            const plan = parseJsonObject(plannedText) || {};
            await insertStep(runId, step, {
                type: 'plan',
                title: plan.thought || 'Agent plan',
                input: { goal: run.goal },
                output: plan,
                durationMs: Date.now() - plannerStartedAt,
                contextHash: stepContext.contextHash
            });

            if (plan.action === 'final' || !plan.tool) {
                const answer = plan.answer || await synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId, {
                    signal: runController.signal,
                    budget: taskBudget,
                    ...plannerChatContext
                });
                await updateRun(runId, {
                    status: 'completed',
                    final_answer: answer,
                    completed_at: getBeijingTimestamp(),
                    last_heartbeat_at: getBeijingTimestamp(),
                    updated_at: getBeijingTimestamp()
                });
                await createAgentNotification(user.id, runId, 'completed', '任务运行完成', getAgentRunTitle(run));
                return;
            }

            const startedAt = Date.now();
            const effectivePlanInput = normalizeToolInput(plan.tool, plan.input || {}, {
                ...run,
                model_id: run.model_id ?? modelCfg?.id,
                chosen_model_id: run.chosen_model_id ?? modelCfg?.id
            });
            try {
                await updateRun(runId, { status: 'executing', updated_at: getBeijingTimestamp() });
                await assertRunUserActive(user);
                assertRunNotCancelled(runId);
                assertRunWithinBudget();
                await updateRun(runId, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
                const selectedTool = findAgentToolByName(plan.tool, toolList);
                const approvalKey = `${runId}:${step}:${plan.tool}`;
                if (await maybePauseForApproval(run, selectedTool, effectivePlanInput, approvalKey)) return;
                const toolContext = {
                    run,
                    modelCfg,
                    autonomous: true,
                    stepId: `${runId}:${step}`,
                    stepIndex: step,
                    stepContext,
                    contextHash: stepContext.contextHash,
                    budget: taskBudget,
                    approvalGranted: isApprovalGranted(run, plan.tool, approvalKey, effectivePlanInput),
                    allowApproval: isApprovalGranted(run, plan.tool, approvalKey, effectivePlanInput),
                    waitForWorkflowDelay,
                    delayKey: plan.tool === 'workflow.delay'
                        ? stableWorkflowDelayKey(plan.tool, step, effectivePlanInput)
                        : ''
                };
                const output = await withTimeout(
                        signal => executeToolByName(plan.tool, effectivePlanInput, user, toolList, { ...toolContext, signal }),
                    Math.min(normalizePositiveInt(run.tool_timeout_ms, AGENT_TOOL_TIMEOUT_MS, 30000, 10 * 60 * 1000), Math.max(deadline - Date.now(), 1000)),
                    `执行工具：${plan.tool}`,
                    { signal: runController.signal }
                );
                assertRunNotCancelled(runId);
                assertRunWithinBudget();
                const compactOutput = compactToolOutputForModel(output, modelCfg);
                await updateRun(runId, { status: 'observing', updated_at: getBeijingTimestamp() });
                observations.push({
                    step,
                    tool: plan.tool,
                    input: effectivePlanInput,
                    output: compactOutput
                });
                await insertStep(runId, step, {
                    type: 'tool',
                    title: `工具执行完成：${plan.tool}`,
                    toolName: plan.tool,
                    input: effectivePlanInput,
                    output: compactOutput,
                    durationMs: Date.now() - startedAt,
                    contextHash: stepContext.contextHash
                });
                try {
                    await recordAgentToolCall({
                        runId,
                        stepId: `${runId}:${step}`,
                        toolName: plan.tool,
                        input: effectivePlanInput,
                        output: compactOutput,
                        policyDecision: 'allow',
                        status: 'success',
                        durationMs: Date.now() - startedAt,
                        contextHash: stepContext.contextHash
                    });
                } catch (auditError) {
                    throw auditError;
                }
                taskBudget.recordSuccess();
            } catch (toolErr) {
                if (toolErr.code === 'AGENT_APPROVAL_REQUIRED') throw toolErr;
                if (toolErr.code === 'AGENT_RECOVERY_REQUIRES_APPROVAL') {
                    const now = getBeijingTimestamp();
                    await setRunMetadata(runId, {
                        pendingApproval: {
                            tool: plan.tool,
                            key: `${runId}:${step}:${plan.tool}`,
                            input: effectivePlanInput,
                            inputHash: approvalInputHash(effectivePlanInput),
                            requestedAt: now,
                            expiresAt: getBeijingTimestamp(new Date(Date.now() + 15 * 60 * 1000)),
                            recovery: true
                        }
                    });
                    await updateRun(runId, { status: 'approval_required', error_message: '检测到未完成的非幂等工具调用，需要重新审批。', updated_at: now, last_heartbeat_at: now });
                    await createAgentNotification(run.user_id, run.id, 'approval', '恢复任务需要重新审批', plan.tool);
                    return;
                }
                await updateRun(runId, { status: 'diagnosing', updated_at: getBeijingTimestamp() });
                observations.push({
                    step,
                    tool: plan.tool,
                    input: effectivePlanInput,
                    error: toolErr.message
                });
                const diagnosis = diagnoseError(toolErr, { tool: plan.tool, step });
                taskBudget.recordError();
                await insertStep(runId, step, {
                    type: 'tool',
                    title: `工具执行失败：${plan.tool}`,
                    toolName: plan.tool,
                    input: effectivePlanInput,
                    output: { error: toolErr.message, diagnosis },
                    errorMessage: toolErr.message,
                    status: 'error',
                    durationMs: Date.now() - startedAt,
                    contextHash: stepContext.contextHash
                });
                try {
                    await recordAgentToolCall({
                        runId,
                        stepId: `${runId}:${step}`,
                        toolName: plan.tool,
                        input: effectivePlanInput,
                        output: { error: toolErr.message, diagnosis },
                        policyDecision: toolErr.code === 'AGENT_POLICY_DENIED' ? 'denied' : 'allow',
                        status: 'error',
                        errorCategory: diagnosis.category,
                        errorMessage: toolErr.message,
                        durationMs: Date.now() - startedAt,
                        contextHash: stepContext.contextHash
                    });
                } catch (auditError) {
                    auditError.cause = toolErr;
                    throw auditError;
                }
                if (step < maxSteps) await updateRun(runId, { status: 'replanning', updated_at: getBeijingTimestamp() });
            }
        }

        assertRunNotCancelled(runId);
        assertRunWithinBudget();
        const limitMessage = `已达到最大执行轮次 ${maxSteps}，结果可能不完整。`;
        await insertStep(runId, (await listSteps(runId)).length + 1, {
            type: 'control',
            title: '已达到最大执行轮次',
            output: { maxSteps, message: limitMessage },
            errorMessage: limitMessage,
            status: 'error'
        });
        const summaryStartedAt = Date.now();
        const summarySpanId = await startAgentTraceSpan(runId, {
            type: 'model',
            name: '生成最终总结',
            input: { observationCount: observations.length, model: modelCfg.name || modelCfg.model_name || modelCfg.id },
            details: { purpose: 'agent_final_summary' }
        });
        let answer;
        try {
            answer = await withTimeout(signal => synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId, {
                signal,
                budget: taskBudget,
                ...plannerChatContext
            }), Math.min(180000, Math.max(deadline - Date.now(), 1000)), 'final summary', { signal: runController.signal });
            await finishAgentTraceSpan(summarySpanId, {
                output: { responseLength: String(answer || '').length },
                durationMs: Date.now() - summaryStartedAt
            });
        } catch (summaryError) {
            await finishAgentTraceSpan(summarySpanId, {
                status: 'error',
                errorMessage: summaryError.message,
                durationMs: Date.now() - summaryStartedAt
            });
            throw summaryError;
        }
        // v0.0.50 自动升级逻辑会在置信度较低时用更强模型重试最终总结。
        if (routerStrategy === 'auto-escalate') {
            const confidence = assessConfidence({ output: answer });
            if (!confidence.confident) {
                try {
                    const escalation = await pickEscalationModel({
                        user,
                        currentModel: modelCfg,
                        messages: [{ role: 'user', content: run.goal || '' }]
                    });
                    if (escalation) {
                        await insertStep(runId, (await listSteps(runId)).length + 1, {
                            type: 'control',
                            title: '模型自动升级：auto-escalate',
                            output: { reason: confidence.reason, fromModelId: modelCfg.id, toModelId: escalation.id, toModelName: escalation.name || escalation.model_name || '' }
                        });
                        logger.info({ runId, reason: confidence.reason, fromModelId: modelCfg.id, toModelId: escalation.id }, '智能体置信度较低，正在升级模型');
                        modelCfg = escalation;
                        await execute('UPDATE agent_runs SET chosen_model_id = ?, updated_at = ? WHERE id = ?', [
                            modelCfg.id, getBeijingTimestamp(), runId
                        ]);
                        answer = await withTimeout(signal => synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId, {
                            signal,
                            budget: taskBudget,
                            ...plannerChatContext
                        }), Math.min(180000, Math.max(deadline - Date.now(), 1000)), 'escalated final summary', { signal: runController.signal });
                    }
                } catch (escErr) {
                    logger.warn({ runId, err: escErr.message }, '自动升级失败，保留首次回答');
                }
            }
        }
        assertRunNotCancelled(runId);
        answer = `注意：${limitMessage}\n\n${answer}`;
        await updateRun(runId, {
            status: 'completed_with_errors',
            final_answer: answer,
            error_message: limitMessage,
            completed_at: getBeijingTimestamp(),
            last_heartbeat_at: getBeijingTimestamp(),
            updated_at: getBeijingTimestamp()
        });
        await createAgentNotification(user.id, runId, 'warning', '任务达到执行轮次上限', limitMessage);
    } catch (e) {
        if (e.code === 'AGENT_RUN_CANCELLED') {
            await updateRun(runId, { updated_at: getBeijingTimestamp() });
            return;
        }
        if (e.code === 'AGENT_APPROVAL_REQUIRED') {
            await updateRun(runId, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
            return;
        }
        logger.error({ err: e.message, runId }, '智能体运行失败');
        if (e.code === 'AGENT_USER_REVOKED' || isRunCancelled(runId)) {
            const currentStatus = await getRunStatus(runId);
            if (currentStatus !== 'cancelled' && currentStatus !== 'deleted') {
                await updateRun(runId, {
                    status: 'cancelled',
                    error_message: e.message,
                    cancelled_at: getBeijingTimestamp(),
                    completed_at: getBeijingTimestamp(),
                    updated_at: getBeijingTimestamp()
                });
            }
            return;
        }
        const retryRow = await queryOne('SELECT retry_limit, retry_count FROM agent_runs WHERE id = ?', [runId]);
        const retryLimit = normalizePositiveInt(retryRow?.retry_limit, 0, 0, 5);
        const retryCount = normalizePositiveInt(retryRow?.retry_count, 0, 0, 99);
        if (retryCount < retryLimit && e.code !== 'AGENT_BUDGET_EXCEEDED' && e.code !== 'AGENT_TIMEOUT') {
            const resumeContext = await buildAgentResumeContext(runId);
            await setRunMetadata(runId, { resumeContext });
            await recordRunRetryReason(runId, {
                attempt: retryCount + 1,
                limit: retryLimit,
                code: e.code || '',
                error: e.message
            });
            await updateRun(runId, {
                status: 'queued',
                error_message: e.message,
                retry_count: retryCount + 1,
                resume_from_step: Number(resumeContext.latestStepIndex || 0),
                updated_at: getBeijingTimestamp()
            });
            await insertStep(runId, (await listSteps(runId)).length + 1, {
                type: 'control',
                title: `任务失败重试：${retryCount + 1}/${retryLimit}`,
                output: { error: e.message }
            });
            // 重新拉取用户，避免复用运行开始时捕获的过期用户对象（运行中用户可能被禁用或修改）
            enqueueAgentRun(runId, (await getRunUser(runId)) || user);
            return;
        }
        const currentStatus = await getRunStatus(runId);
        if (TERMINAL_STATUSES.has(currentStatus)) return;
        await updateRun(runId, {
            status: 'error',
            error_message: e.message,
            completed_at: getBeijingTimestamp(),
            last_heartbeat_at: getBeijingTimestamp(),
            updated_at: getBeijingTimestamp()
        });
        await createAgentNotification(user.id, runId, 'error', '智能体运行失败', e.message);
    } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (activeRunControllers.get(runId) === runController) activeRunControllers.delete(runId);
        if (taskBudget) {
            try { await updateRun(runId, { usage_stats: JSON.stringify(taskBudget.snapshot()), updated_at: getBeijingTimestamp() }); } catch (_) {}
        }
        await syncAgentTraceFromRun(runId);
    }
}

function enqueueAgentRun(runId, _user) {
    getAgentQueue().enqueueRun(runId);
}

async function recoverAgentRuns() {
    const now = getBeijingTimestamp();
    const cutoff = getBeijingTimestamp(new Date(Date.now() - (AGENT_STALE_RUNNING_MINUTES * 60 * 1000)));
    const staleRunning = await query(`
        SELECT id FROM agent_runs
        WHERE status IN ('running', 'planning', 'executing', 'observing', 'diagnosing', 'replanning', 'resuming')
          AND deleted_at IS NULL
          AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)
    `, [cutoff]);
    for (const run of staleRunning) {
        const pending = await queryOne(`
            SELECT tool_name, input_hash, idempotent, operation_key, state
            FROM agent_run_checkpoints
            WHERE run_id = ? AND status = 'pending'
            ORDER BY step_index DESC, id DESC LIMIT 1
        `, [run.id]);
        const runMetadataRow = await queryOne('SELECT metadata FROM agent_runs WHERE id = ?', [run.id]);
        const safeResume = pending && Boolean(pending.idempotent);
        const targetStatus = pending && !safeResume ? 'approval_required' : safeResume ? 'queued' : 'error';
        const recoveryFields = {
            status: targetStatus,
            error_message: targetStatus === 'error' ? '服务已重启或心跳超时，任务已标记为失败。' : targetStatus === 'approval_required' ? '检测到未完成的非幂等工具调用，需要重新审批。' : null,
            updated_at: now,
            last_heartbeat_at: now,
            locked_by: null,
            lock_expires_at: null
        };
        if (targetStatus === 'error') recoveryFields.completed_at = now;
        if (targetStatus === 'approval_required') {
            let metadata = {};
            try { metadata = JSON.parse(runMetadataRow?.metadata || '{}'); } catch (_) {}
            recoveryFields.metadata = JSON.stringify({ ...metadata, pendingApproval: { tool: pending.tool_name, operationKey: pending.operation_key, recovery: true } });
        }
        const changed = await updateRunCas(run.id, ['running', 'planning', 'executing', 'observing', 'diagnosing', 'replanning', 'resuming'], recoveryFields);
        if (!changed) continue;
        const abortError = new Error('停滞任务已恢复并标记终止。');
        abortError.code = 'AGENT_RUN_CANCELLED';
        activeRunControllers.get(run.id)?.abort(abortError);
        if (targetStatus !== 'queued') await insertStep(run.id, (await listSteps(run.id)).length + 1, {
            type: 'control',
            title: targetStatus === 'approval_required' ? '运行时恢复并等待副作用审批' : '运行时恢复并标记停滞任务',
            output: { status: targetStatus, reason: targetStatus === 'error' ? 'stale_running' : 'pending_tool_recovery' }
        });
    }

    const recoveredQueued = await getAgentQueue().recoverQueued(100, { deferSchedule: true });
    let recoveredChatResults = null;
    try {
        recoveredChatResults = await recoverChatAgentResults({ limit: 200 });
    } catch (error) {
        logger.error({ err: error.message }, '普通聊天 Agent 结果恢复扫描失败');
    }
    if (recoveredQueued > 0 || staleRunning.length > 0) {
        logger.info({ recoveredQueued, staleRunning: staleRunning.length, recoveredChatResults }, '智能体运行时异常任务恢复完成');
    } else {
        logger.debug({ recoveredQueued, staleRunning: staleRunning.length, recoveredChatResults }, '智能体运行时周期巡检完成');
    }
}

function startAgentRecoveryRunner(intervalMs = 60 * 1000) {
    if (agentRecoveryTimer) return agentRecoveryTimer;
    const safeInterval = Math.max(Number.parseInt(intervalMs, 10) || 60000, 30000);
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await recoverAgentRuns();
        } catch (error) {
            logger.warn({ err: error.message }, '定时恢复停滞智能体任务失败');
        } finally {
            running = false;
        }
    };
    const timer = setInterval(tick, safeInterval);
    timer.unref?.();
    agentRecoveryTimer = timer;
    return agentRecoveryTimer;
}

async function approveAgentTool(runId, user, approve = true) {
    const run = await getRunForUser(runId, user);
    if (!run) return null;
    if (run.status !== 'approval_required') return run;
    const metadata = getRunMetadata(run);
    const pending = metadata.pendingApproval || {};
    const now = getBeijingTimestamp();
    if (!approve) {
        await updateRun(runId, {
            status: 'cancelled',
            error_message: `用户拒绝工具审批：${pending.tool || '-'}`,
            cancelled_at: now,
            completed_at: now,
            updated_at: now
        });
        await setRunMetadata(runId, { pendingApproval: null });
        await insertStep(runId, (await listSteps(runId)).length + 1, {
            type: 'approval',
            title: 'User rejected tool approval',
            toolName: pending.tool || '',
            output: { status: 'rejected' }
        });
        try {
            await recordAgentEvent({
                runId,
                userId: user.id,
                type: 'approval.rejected',
                payload: { tool: pending.tool || '', key: pending.key || '' },
                eventKey: `approval:${pending.key || pending.tool || 'unknown'}:rejected`
            });
        } catch (_) {}
        await createAgentNotification(user.id, runId, 'cancelled', '审批未通过', pending.tool || getAgentRunTitle(run));
        return await getRunForUser(runId, user);
    }
    const approvedTools = new Set(Array.isArray(metadata.approvedTools) ? metadata.approvedTools : []);
    const approvedApprovalKeys = new Set(Array.isArray(metadata.approvedApprovalKeys) ? metadata.approvedApprovalKeys : []);
    if (pending.key) approvedApprovalKeys.add(pending.key);
    else if (pending.tool) approvedTools.add(pending.tool);
    const approvalGrant = {
        tool: pending.tool || '',
        key: pending.key || '',
        inputHash: pending.inputHash || approvalInputHash(pending.input || {}),
        grantedAt: now,
        expiresAt: pending.expiresAt || getBeijingTimestamp(new Date(Date.now() + 15 * 60 * 1000))
    };
    const approvalGrants = Array.isArray(metadata.approvalGrants)
        ? metadata.approvalGrants.filter(item => item && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()))
        : [];
    approvalGrants.push(approvalGrant);
    await setRunMetadata(runId, {
        pendingApproval: null,
        approvalGrants,
        approvedTools: [...approvedTools],
        approvedApprovalKeys: [...approvedApprovalKeys]
    });
    await updateRun(runId, { status: 'queued', error_message: '', updated_at: now });
    await insertStep(runId, (await listSteps(runId)).length + 1, {
        type: 'approval',
        title: 'User approved tool call',
        toolName: pending.tool || '',
        output: { status: 'approved', tool: pending.tool || '' }
    });
    try {
        await recordAgentEvent({
            runId,
            userId: user.id,
            type: 'approval.granted',
            payload: { tool: pending.tool || '', key: pending.key || '', inputHash: approvalGrant.inputHash },
            eventKey: `approval:${pending.key || pending.tool || 'unknown'}:granted:${approvalGrant.inputHash}`
        });
    } catch (_) {}
    enqueueAgentRun(runId, user);
    return await getRunForUser(runId, user);
}

async function getAgentRuntimeStatus(user = null) {
    const queueStatus = await getAgentQueue().getStatus();
    return await buildAgentRuntimeStatus({
        maxConcurrent: getAgentMaxConcurrentRuns(),
        dagNodeConcurrency: getAgentDagNodeConcurrency(),
        queueStatus,
        user
    });
}

async function syncAgentRuntimeConcurrency() {
    const queue = getAgentQueue();
    queue.updateMaxConcurrent?.(getAgentMaxConcurrentRuns());
    const processing = queue.processQueue?.();
    if (processing && typeof processing.catch === 'function') {
        processing.catch(err => logger.warn({ err: err.message }, '智能体队列并发配置同步失败'));
    }
    return await queue.getStatus();
}

configureAgentSchedules({
    createAgentRun,
    createAgentNotification,
    // 数据变更触发需要执行只读查询，按触发器所属账号解析可用工具后走统一执行入口，
    // 继续保留工具治理、只读校验和连接归属检查
    runPollingTriggers: () => runDuePollingTriggers({
        executeTool: async (toolName, input, triggerUser) => executeToolByName(
            toolName,
            input,
            triggerUser,
            await formatToolList(triggerUser, { toolPolicy: 'all' }),
            { source: 'trigger' }
        )
    }),
    runApprovalTimeouts
});

configureAgentApprovalRequests({
    updateRun,
    updateRunCas,
    insertStep,
    listSteps,
    setRunMetadata,
    upsertDagNode,
    createAgentNotification,
    enqueueAgentRun,
    getAgentRunTitle
});

configureAgentTriggers({
    createAgentRun,
    createAgentNotification
});

configureAgentArtifacts({
    createAgentNotification,
    getAgentRunTitle,
    getRunDetailForUser: getRunDetailForUserHelper
});

async function createAgentRun({
    user,
    goal,
    modelId,
    sessionId = null,
    title = '',
    maxSteps = 0,
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
    budgetConfig = {},
    networkPolicy = {},
    templateId = null,
    scheduleId = null,
    contextConfig = {},
    resumeFromStep = 0,
    metadata = {},
    dagSpec = null,
    dagInputs = null,
    workflowId = null,
    workflowVersion = null,
    modelRouter = 'fixed',
    dedupeKey = null,
    skillId = null,
    skillName = null,
    forkHistory = 'none'
}) {
    await assertRunUserActive(user);
    const normalizedScheduleId = scheduleId === null || scheduleId === '' ? null : Number(scheduleId);
    if (normalizedScheduleId !== null && (!Number.isInteger(normalizedScheduleId) || normalizedScheduleId <= 0)) {
        const err = new Error('计划标识无效。');
        err.status = 400;
        throw err;
    }
    if (normalizedScheduleId !== null && !(await queryOne('SELECT id FROM agent_schedules WHERE id = ? AND user_id = ?', [normalizedScheduleId, user.id]))) {
        const err = new Error('计划不存在或无权使用。');
        err.status = 403;
        throw err;
    }
    const normalizedTemplateId = templateId === null || templateId === '' ? null : Number(templateId);
    if (normalizedTemplateId !== null && (!Number.isInteger(normalizedTemplateId) || normalizedTemplateId <= 0)) {
        const err = new Error('任务模板标识无效。');
        err.status = 400;
        throw err;
    }
    if (normalizedTemplateId !== null) {
        const template = await queryOne('SELECT * FROM agent_templates WHERE id = ?', [normalizedTemplateId]);
        if (!assertTemplateAccess(template, user, false)) {
            const err = new Error('任务模板不存在或无权使用。');
            err.status = 403;
            throw err;
        }
    }
    const normalizedDedupeKey = dedupeKey ? String(dedupeKey).trim().slice(0, 240) : null;
    if (normalizedDedupeKey) {
        const existing = await queryOne('SELECT * FROM agent_runs WHERE user_id = ? AND dedupe_key = ? AND deleted_at IS NULL', [user.id, normalizedDedupeKey]);
        if (existing) return existing;
    }
    const normalizedToolPolicy = normalizeToolPolicy(toolPolicy);
    const normalizedRunMode = normalizeRunMode(runMode);
    const normalizedRouter = normalizeRouterStrategy(modelRouter);
    const runMetadata = metadata && typeof metadata === 'object' ? { ...metadata } : {};
    const normalizedForkHistory = normalizeForkHistory(forkHistory || runMetadata.forkHistory || runMetadata.fork_history || 'none');
    let resourceReservation = null;
    let effectiveChildTokenBudget = normalizePositiveInt(maxTokenBudget, 0, 0, 10000000);
    const skillReference = skillId || skillName || runMetadata.skillId || runMetadata.skillName || '';
    delete runMetadata.skillPermissions;
    delete runMetadata.skillTools;
    if (skillReference) {
        const skillContext = await getAgentSkillExecutionContext(user, skillReference);
        runMetadata.skillId = skillContext.skillId;
        runMetadata.skillName = skillContext.skillName;
        runMetadata.skillVersion = skillContext.skillVersion;
        runMetadata.skillPermissions = skillContext.skillPermissions;
        runMetadata.skillTools = skillContext.skillTools;
    }
    const cleanGoal = normalizeAgentGoal(normalizedRunMode === 'dag'
        ? await inferDagRunGoal({ goal, title, workflowId, runMetadata, dagSpec, user })
        : goal);
    const runId = createRunId();
    const now = getBeijingTimestamp();
    const normalizedDagInputs = normalizeDagInputsPayload(dagInputs || runMetadata.dagInputs || runMetadata.inputs || {});
    if (Object.keys(normalizedDagInputs).length) {
        runMetadata.dagInputs = normalizedDagInputs;
    }
    let effectiveModelId = modelId;
    const effectiveMaxSteps = resolveMaxSteps(maxSteps, normalizedRunMode);
    if (normalizedRunMode === 'dag') {
        const requestedWorkflowId = workflowId || runMetadata.workflowId || runMetadata.workflow_id || null;
        const requestedWorkflowVersion = workflowVersion || runMetadata.workflowVersion || runMetadata.workflow_version || null;
        if (requestedWorkflowId && requestedWorkflowVersion) {
            const sourceWorkflow = await resolveAgentWorkflowVersion(requestedWorkflowId, user, requestedWorkflowVersion || 'current');
            if (!sourceWorkflow) {
                const err = new Error('工作流版本不可用。');
                err.status = 404;
                throw err;
            }
            const resolvedWorkflow = await resolveAgentWorkflowDependencyBindings(sourceWorkflow, user);
            runMetadata.dagSpec = resolvedWorkflow.dagSpec;
            runMetadata.workflowId = resolvedWorkflow.workflow.id;
            runMetadata.workflowName = resolvedWorkflow.workflow.name;
            runMetadata.workflowVersion = resolvedWorkflow.version;
            runMetadata.workflowVersionMode = resolvedWorkflow.mode;
            runMetadata.workflowVersionId = resolvedWorkflow.version_id;
            runMetadata.workflowDependencyBinding = {
                required: Boolean(resolvedWorkflow.dependency_binding?.required),
                versionId: resolvedWorkflow.dependency_binding?.bound_version_id || null,
                updatedAt: resolvedWorkflow.dependency_binding?.updated_at || ''
            };
        } else {
            runMetadata.dagSpec = normalizeDagSpec(dagSpec || runMetadata.dagSpec || {});
        }
        assertWorkflowLlmNodesConfigured(runMetadata.dagSpec);
        await assertAgentWorkflowDependencies(runMetadata.dagSpec, user);
    }
    const modelCfg = await getRunnableModelForUserAsync(effectiveModelId, user);
    if (!modelCfg && normalizedRunMode !== 'dag') throw new Error('请选择当前账号可用的模型。');
    if (parentRunId) {
        const inherited = await reserveChildRunResources({
            parentRunId,
            userId: user.id,
            requestedTokenBudget: effectiveChildTokenBudget,
            forkHistory: normalizedForkHistory
        });
        effectiveChildTokenBudget = inherited.tokenBudget;
        resourceReservation = inherited.reservation;
        runMetadata.resourceInheritance = {
            parentRunId: String(parentRunId),
            tokenBudget: effectiveChildTokenBudget,
            forkHistory: inherited.forkHistory
        };
        if (inherited.forkHistory.mode !== 'none') {
            try {
                runMetadata.parentHistory = await buildForkHistory(parentRunId, user.id, inherited.forkHistory);
            } catch (error) {
                try { await cancelChildRunReservation({ parentRunId, userId: user.id, tokenBudget: effectiveChildTokenBudget }); } catch (_) {}
                throw error;
            }
        }
    }
    try {
        await execute(`
            INSERT INTO agent_runs (
                id, user_id, session_id, model_id, title, goal, status, max_steps, parent_run_id,
                priority, run_mode, tool_policy, tool_allowlist, approval_policy, timeout_ms, tool_timeout_ms,
                retry_limit, max_token_budget, template_id, schedule_id, dedupe_key, context_config, resume_from_step,
                metadata, model_router, budget_config, usage_stats, network_policy, created_at, updated_at
            )
            VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
        `, [
            runId,
            user.id,
            sessionId || null,
            modelCfg?.id || null,
            normalizeAgentTitle(title, cleanGoal),
            cleanGoal,
            'queued',
            normalizeMaxSteps(effectiveMaxSteps, normalizedRunMode),
            parentRunId || null,
            normalizePriority(priority),
            normalizedRunMode,
            normalizedToolPolicy,
            serializeToolAllowlist(toolAllowlist),
            normalizeApprovalPolicy(approvalPolicy),
            normalizePositiveInt(timeoutMs, AGENT_DEFAULT_TIMEOUT_MS, 60000, 24 * 60 * 60 * 1000),
            normalizePositiveInt(toolTimeoutMs, AGENT_TOOL_TIMEOUT_MS, 30000, 10 * 60 * 1000),
            normalizePositiveInt(retryLimit, 1, 0, 5),
            effectiveChildTokenBudget,
            normalizedTemplateId,
            normalizedScheduleId,
            normalizedDedupeKey,
            serializeContextConfig(contextConfig),
            normalizePositiveInt(resumeFromStep, 0, 0, 999),
            JSON.stringify(runMetadata),
            normalizedRouter,
            JSON.stringify(normalizeTaskBudget(budgetConfig)),
            JSON.stringify({}),
            JSON.stringify(networkPolicy || {}),
            now,
            now
        ]);
    } catch (err) {
        if (resourceReservation) {
            try { await cancelChildRunReservation({ parentRunId, userId: user.id, tokenBudget: effectiveChildTokenBudget }); } catch (_) {}
        }
        if (normalizedDedupeKey && (String(err.code || '').includes('CONSTRAINT') || String(err.code || '').includes('23505'))) {
            const existing = await queryOne('SELECT * FROM agent_runs WHERE user_id = ? AND dedupe_key = ? AND deleted_at IS NULL', [user.id, normalizedDedupeKey]);
            if (existing) return existing;
        }
        throw err;
    }
    await initializeAgentRunResources({
        runId,
        userId: user.id,
        parentRunId,
        tokenBudget: effectiveChildTokenBudget,
        forkHistory: normalizedForkHistory
    });
    if (normalizedRunMode === 'dag' && Array.isArray(runMetadata.dagSpec?.nodes) && runMetadata.dagSpec.nodes.length > 0) {
        const { upsertDagNode } = require('../agent-dag-runtime');
        for (const node of runMetadata.dagSpec.nodes) {
            await upsertDagNode(runId, node, { status: 'pending' });
        }
    }
    enqueueAgentRun(runId, user);
    const run = await getRunForUser(runId, user);
    await publishAgentRunEvent(runId, 'created');
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
    listAgentWorkflowShareOptions,
    listAgentWorkflowVersions,
    listAgentWorkflows,
    getAgentMetrics,
    getAgentQueue,
    getAgentRuntimeStatus,
    syncAgentRuntimeConcurrency,
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
    startAgentRecoveryRunner,
    recordRunRetryReason,
    runAgentScheduleNow,
    runDueAgentSchedules,
    runDuePollingTriggers,
    createWorkflowTrigger,
    deleteWorkflowTrigger,
    listWorkflowTriggers,
    rotateWorkflowTriggerToken,
    updateWorkflowTrigger,
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
    updateAgentWorkflow,
    updateAgentWorkflowMetadata,
    updateAgentWorkflowSharing
};
