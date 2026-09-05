const { query, queryOne, execute } = require('../../db/client');
const crypto = require('crypto');
const { logger } = require('../../logger');
const { getBeijingTimestamp } = require('../../time');
const { getRunnableModelForUserAsync } = require('../models');
const { clampText, compactToolOutputForModel, executeToolByName, findAgentToolByName } = require('../agent-tool-runtime');
const { runAgentDag, upsertDagNode } = require('../agent-dag-runtime');
const { isStreamingToolsEnabled, tryRunAgentStreaming } = require('../agent-streaming-runtime');
const { createAgentQueue } = require('../agent-queue');
const { callModelText, recordAgentModelUsage, AGENT_ANSWER_MIN_MAX_TOKENS } = require('../agent-model');
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
    updateAgentTemplate
} = require('../agent-templates');
const {
    createAgentWorkflow,
    deleteAgentWorkflow,
    diffAgentWorkflowVersions,
    getAgentWorkflowForUser,
    listAgentWorkflowVersions,
    listAgentWorkflows,
    listAgentWorkflowShareOptions,
    publishAgentWorkflowVersion,
    restoreAgentWorkflow,
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
    createStandaloneArtifact,
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
    getAgentMetrics,
    getAgentRuntimeStatus: buildAgentRuntimeStatus
} = require('../agent-monitoring');
const {
    ACTIVE_STATUSES,
    parseJsonObject,
    normalizeMaxSteps,
    normalizeRunMode,
    normalizeToolPolicy,
    normalizeApprovalPolicy,
    normalizePositiveInt,
    normalizeDagSpec,
    normalizeToolAllowlist,
    normalizeAgentGoal
} = require('../agent-validators');
const {
    AGENT_DEFAULT_TIMEOUT_MS,
    AGENT_TOOL_TIMEOUT_MS,
    AGENT_STALE_RUNNING_MINUTES,
    AGENT_QUEUE_LOCK_MS,
    AGENT_INSTANCE_ID,
    getAgentMaxConcurrentRuns,
    getAgentDagNodeConcurrency,
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
const { TaskBudget, normalizeTaskBudget } = require('../agent-budget');
const { diagnoseError } = require('../agent-diagnosis');
const { recordAgentToolCall } = require('../agent-tool-audit');
const { recordAgentRunOutcome } = require('../agent-feedback');
const { listToolReliability, selectToolOrder } = require('../agent-tool-reliability');
const { enqueueChannelDelivery, dispatchChannelDeliveries } = require('../agent-channel-adapters');
const { createAgentInboxEvent } = require('../agent-inbox');
const { createPersistedAgentStepContext } = require('../agent-world-state-store');
const { buildAgentAuditFields } = require('../agent-step-context');
const { recordAgentEvent } = require('../agent-event-log');
const { claimAgentControlMessages } = require('../agent-control');
const {
    releaseChildRunReservation
} = require('../agent-run-resources');
const {
    configureAgentApprovalRequests,
    runApprovalTimeouts,
    waitForWorkflowApproval,
    waitForWorkflowDelay
} = require('../agent-approval-requests');
const {
    configureAgentGoals,
    createAgentGoal,
    dispatchAgentGoalWebhook,
    getAgentGoal,
    listAgentGoals,
    recordAgentGoalRunOutcome,
    runAgentGoalNow,
    runDueAgentGoals,
    setAgentGoalStatus,
    updateAgentGoal
} = require('../agent-goals');
const { maybeArchiveStalePersonalExperiences, processAgentLearningJobs } = require('../agent-learning');

const { buildPlannerMessages, synthesizeFinalAnswer, isMissingFinalAnswer } = require('./planner');
const { createAgentNotificationFactory } = require('./notifications');
const { createApprovalHelpers } = require('./approvals');
const { createRunState } = require('./run-state');
const { createRunLifecycle } = require('./run-lifecycle');
const { createAgentRunner } = require('./run-execution');
const { buildVisionHistory, limitVisionImages } = require('../chat-vision');
const {
    isChatAgentRun,
    persistAgentRunChatResult,
    recoverChatAgentResults
} = require('../chat-agent-bridge');


let agentQueue = null;
const activeRunControllers = new Map();
const taskBudgetsBySignal = new WeakMap();
let agentRecoveryTimer = null;
const createAgentNotification = createAgentNotificationFactory({
    getTimestamp: getBeijingTimestamp,
    publishUserEvent,
    createInboxEvent: createAgentInboxEvent,
    deliverNotification: async (userId, notification) => {
        const bindings = await query('SELECT id FROM agent_channel_bindings WHERE user_id = ? AND status = \'active\'', [userId]);
        for (const binding of bindings) await enqueueChannelDelivery({ id: userId }, { bindingId: binding.id, eventType: `agent.notification.${notification.type || 'info'}`, sourceId: notification.id, runId: notification.run_id, idempotencyKey: `notification:${notification.id}`, subject: notification.title, body: notification.body || '' });
    }
});
const runState = createRunState({
    queryOne,
    execute,
    logger,
    getBeijingTimestamp,
    getAgentRunTitle,
    getRunMetadata,
    assertAgentRunStatusTransition,
    canTransitionAgentRunStatus,
    TERMINAL_STATUSES,
    releaseChildRunReservation,
    persistAgentRunChatResult,
    recordAgentRunOutcome,
    recordAgentEvent,
    crypto,
    publishUserEvent,
    parseJsonObject
});
const {
    assertRunUserActive,
    getRunStatus,
    getRunUser,
    markRunError,
    publishAgentRunEvent,
    recordRunRetryReason,
    setRunMetadata,
    stableWorkflowDelayKey,
    updateRun,
    updateRunCas
} = runState;

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

const { runAgent } = createAgentRunner({
    activeRunControllers,
    taskBudgetsBySignal,
    assertRunNotCancelled: runId => {
        if (activeRunControllers.get(runId)?.signal?.aborted !== true) return;
        const error = new Error('任务已停止。');
        error.code = 'AGENT_RUN_CANCELLED';
        throw error;
    },
    isRunCancelled: runId => activeRunControllers.get(runId)?.signal?.aborted === true,
    assertRunUserActive,
    AGENT_DEFAULT_TIMEOUT_MS,
    AGENT_TOOL_TIMEOUT_MS,
    AGENT_ANSWER_MIN_MAX_TOKENS,
    getRunForUser,
    getRunUser,
    getRunnableModelForUserAsync,
    clampText,
    compactToolOutputForModel,
    executeToolByName,
    findAgentToolByName,
    runAgentDag,
    upsertDagNode,
    isStreamingToolsEnabled,
    tryRunAgentStreaming,
    callModelText,
    recordAgentModelUsage,
    normalizeToolInput,
    publishUserEvent,
    chooseModel,
    normalizeRouterStrategy,
    assessConfidence,
    pickEscalationModel,
    getModelEndpointRuntimeStatus,
    getAgentRuntimeDeps,
    execute,
    queryOne,
    updateRun,
    getRunStatus,
    getAgentQueue,
    insertStep,
    listSteps,
    getRunMetadata,
    getAgentRunTitle,
    formatToolList,
    listToolReliability,
    selectToolOrder,
    normalizeMaxSteps,
    normalizeRunMode,
    normalizeToolPolicy,
    normalizePositiveInt,
    parseJsonObject,
    normalizeTaskBudget,
    TaskBudget,
    recordAgentToolCall,
    recordAgentTraceSpan,
    ensureAgentTrace,
    createAgentNotification,
    createPersistedAgentStepContext,
    recordAgentEvent,
    buildAgentAuditFields,
    buildPlannerMessages,
    synthesizeFinalAnswer,
    isMissingFinalAnswer,
    withTimeout,
    buildVisionHistory,
    limitVisionImages,
    diagnoseError,
    buildAgentResumeContext,
    claimAgentControlMessages,
    approvalInputHash,
    maybePauseForApproval,
    isApprovalGranted,
    waitForWorkflowDelay,
    stableWorkflowDelayKey,
    setRunMetadata,
    recordRunRetryReason,
    enqueueAgentRun,
    startAgentTraceSpan,
    finishAgentTraceSpan,
    syncAgentTraceFromRun,
    TERMINAL_STATUSES,
    logger,
    getBeijingTimestamp,
    crypto
});

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
    const resumeContext = await buildAgentResumeContext(runId);
    await setRunMetadata(runId, {
        pendingApproval: null,
        approvalGrants,
        approvedTools: [...approvedTools],
        approvedApprovalKeys: [...approvedApprovalKeys],
        resumeContext: {
            ...resumeContext,
            previousStatus: run.status,
            approvedTool: pending.tool || '',
            approvedInputHash: approvalGrant.inputHash
        }
    });
    await updateRun(runId, {
        status: 'queued',
        error_message: '',
        resume_from_step: Number(resumeContext.latestStepIndex || run.resume_from_step || 0) || 0,
        updated_at: now
    });
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

const { createAgentRunFactory } = require('./run-creation');
const createAgentRun = createAgentRunFactory({
    assertRunUserActive,
    enqueueAgentRun,
    publishAgentRunEvent
});

const lifecycle = createRunLifecycle({
    activeRunControllers,
    ACTIVE_STATUSES,
    buildAgentResumeContext,
    clampText,
    createAgentNotification,
    createAgentRun,
    getAgentRunTitle,
    getBeijingTimestamp,
    getRunForUser,
    getRunMetadata,
    insertStep,
    isChatAgentRun,
    listDagNodes,
    listSteps,
    normalizeDagSpec,
    normalizeToolAllowlist,
    parseJsonObject,
    query,
    updateRun
});
const {
    assertRunNotCancelled,
    cancelAgentRun,
    rerunAgentDagFromNode,
    rerunAgentRun,
    resumeAgentRun,
    softDeleteAgentRun
} = lifecycle;

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
    runApprovalTimeouts,
    runProactiveGoals: () => runDueAgentGoals(),
    runChannelDeliveries: () => dispatchChannelDeliveries(50, { onDeadLetter: delivery => createAgentInboxEvent({ id: delivery.user_id }, { eventKey: `channel.dead_letter:${delivery.id}`, eventType: 'channel.dead_letter', sourceId: String(delivery.id), title: '渠道消息进入死信', body: delivery.last_error || '渠道投递失败次数超过上限。', risk: 'high', payload: { deliveryId: delivery.id, attempts: delivery.attempts } }) }),
    runLearningJobs: async () => {
        const jobs = await processAgentLearningJobs({ limit: 2 });
        await maybeArchiveStalePersonalExperiences();
        return jobs;
    }
});

configureAgentGoals({
    createAgentRun,
    createAgentNotification,
    executeReadOnlyQuery: async (connectionId, sql, triggerUser) => executeToolByName('db.run_readonly_query', { connectionId, sql }, triggerUser, await formatToolList(triggerUser, { toolPolicy: 'builtin_only' }), { source: 'goal' })
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

module.exports = {
    createAgentRun,
    createAgentArtifactVersion,
    createStandaloneArtifact,
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
    createAgentGoal,
    dispatchAgentGoalWebhook,
    getAgentGoal,
    listAgentGoals,
    recordAgentGoalRunOutcome,
    runAgentGoalNow,
    runDueAgentGoals,
    setAgentGoalStatus,
    updateAgentGoal,
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
