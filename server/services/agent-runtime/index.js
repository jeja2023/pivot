const { query, queryOne, execute } = require('../../db/client');
const crypto = require('crypto');
const { logger } = require('../../logger');
const { getBeijingTimestamp } = require('../../time');
const { getRunnableModelForUserAsync } = require('../models');
const { clampText, compactToolOutputForModel, executeToolByName, findAgentToolByName } = require('../agent-tool-runtime');
const { runAgentDag, upsertDagNode } = require('../agent-dag-runtime');
const { isStreamingToolsEnabled, tryRunAgentStreaming } = require('../agent-streaming-runtime');
const { createAgentQueue } = require('../agent-queue');
const { callModelText, recordAgentModelUsage, resolveAgentPlanningThinking, resolveAgentRequestTimeoutMs, AGENT_ANSWER_MIN_MAX_TOKENS } = require('../agent-model');
const { normalizeToolInput } = require('../agent-policy');
const { publishUserEvent } = require('../realtime-events');
const {
    chooseModel,
    normalizeStrategy: normalizeRouterStrategy,
    assessConfidence,
    isRecoverableModelProviderFailure,
    modelProviderFailureReason,
    pickFailoverModel,
    pickEscalationModel
} = require('../model-router');
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
    listWorkflowTriggerEvents,
    listWorkflowTriggers,
    replayWorkflowTriggerEvent,
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
    runAgentRuntimeSloMonitor,
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
} = require('../agent-validators');
const {
    AGENT_DEFAULT_TIMEOUT_MS,
    AGENT_TOOL_TIMEOUT_MS,
    AGENT_AUTO_CONTINUE_ON_TIMEOUT,
    AGENT_AUTO_CONTINUE_ON_STEP_LIMIT,
    AGENT_MAX_AUTO_CONTINUATIONS,
    AGENT_MAX_TOTAL_RUNTIME_MS,
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
const { recordFirstTaskCreated, recordFirstTaskTerminal } = require('../agent-experience-events');
const { listToolReliability, selectToolOrder } = require('../agent-tool-reliability');
const { enqueueChannelDelivery, dispatchChannelDeliveries } = require('../agent-channel-adapters');
const { configureAgentChannelGateway, deliverChannelGatewayRunResult } = require('../agent-channel-gateway');
const { recordCollaboratorCompletion } = require('../agent-collaboration');
const { createAgentInboxEvent } = require('../agent-inbox');
const { createPersistedAgentStepContext } = require('../agent-world-state-store');
const { persistWorkingMemoryRevision } = require('../agent-working-memory-revisions');
const { recordPromptInvocation, resolveActivePromptSection } = require('../agent-prompt-registry');
const { buildAgentAuditFields } = require('../agent-step-context');
const { recordAgentEvent } = require('../agent-event-log');
const {
    acknowledgeAppliedAgentControlMessages,
    applyAgentControlMessages,
    claimAgentControlMessages,
    listAppliedAgentControlMessages
} = require('../agent-control');
const {
    releaseChildRunReservation
} = require('../agent-run-resources');
const {
    acquireRunConcurrencyLease,
    releaseRunConcurrencyLease,
    renewRunConcurrencyLease
} = require('../agent-run-concurrency-leases');
const {
    configureAgentApprovalRequests,
    runApprovalTimeouts,
    waitForWorkflowApproval,
    waitForWorkflowDelay
} = require('../agent-approval-requests');
const {
    configureAgentGoals,
    createAgentGoal,
    deliverGoalRunResult,
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
const { verifyAndRecordTaskOutcome } = require('../agent-verification');
const {
    createTaskTransaction,
    getTaskTransactionForUser,
    transitionTaskTransaction
} = require('../agent-task-transactions');
const { dispatchPreLifecycleHook, dispatchPostLifecycleHook } = require('../agent-lifecycle-dispatcher');
const { buildPlannerMessages, synthesizeFinalAnswer, isMissingFinalAnswer } = require('./planner');
const { createAgentNotificationFactory } = require('./notifications');
const { createApprovalHelpers } = require('./approvals');
const { createRunState } = require('./run-state');
const { createApprovalRevocation } = require('./approval-revocation');
const { createRunLifecycle } = require('./run-lifecycle');
const { createAgentRunner } = require('./run-execution');
const { calculateAgentRetryDelayMs } = require('./retry-policy');
const { updateAgentRunMetadataWithRetry } = require('../agent-run-metadata-patch');
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
    deliverNotification: async (userId, notification) => {
        const channelRun = notification.run_id
            ? await queryOne('SELECT metadata FROM agent_runs WHERE id = ?', [notification.run_id])
            : null;
        const gatewayBindingId = parseJsonObject(channelRun?.metadata || '{}')?.channelGateway?.bindingId || '';
        const bindings = await query('SELECT id FROM agent_channel_bindings WHERE user_id = ? AND status = \'active\'', [userId]);
        for (const binding of bindings) {
            // 双向会话的最终正文由 channel.agent_result 单独投递；同一绑定不再叠加一条泛通知。
            if (gatewayBindingId && String(binding.id) === String(gatewayBindingId)) continue;
            await enqueueChannelDelivery({ id: userId }, { bindingId: binding.id, eventType: `agent.notification.${notification.type || 'info'}`, sourceId: notification.id, runId: notification.run_id, idempotencyKey: `notification:${notification.id}`, subject: notification.title, body: notification.body || '' });
        }
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
    deliverChannelGatewayRunResult,
    deliverGoalRunResult,
    recordCollaboratorCompletion: (runId, status) => recordCollaboratorCompletion(runId, status, { createAgentRun }),
    recordAgentRunOutcome,
    recordFirstTaskTerminal,
    recordAgentEvent,
    dispatchPreLifecycleHook,
    dispatchPostLifecycleHook,
    crypto,
    publishUserEvent,
    parseJsonObject,
    updateAgentRunMetadataWithRetry
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
            getTimestamp: getBeijingTimestamp,
            acquireRunConcurrencyLease,
            renewRunConcurrencyLease,
            releaseRunConcurrencyLease,
            onRunLeaseLost: (runId, reason) => {
                const error = new Error(`任务执行租约已失效：${reason || 'unknown'}。`);
                error.code = 'AGENT_RUN_LEASE_LOST';
                activeRunControllers.get(runId)?.abort(error);
            }
        });
    }
    return agentQueue;
}


async function insertStep(runId, stepIndex, data = {}) {
    const now = getBeijingTimestamp();
    const maxRow = await queryOne('SELECT COALESCE(MAX(step_index), 0) AS max_index FROM agent_steps WHERE run_id = ?', [runId]);
    const maxIndex = Number(maxRow?.max_index || 0);
    let safeStepIndex = Number.isInteger(stepIndex) && stepIndex > maxIndex ? stepIndex : maxIndex + 1;
    const insertStepSql = `
        INSERT INTO agent_steps (
            run_id, step_index, type, title, tool_name, input, output, error_message,
            status, duration_ms, started_at, completed_at, created_at, context_hash
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const insertStepParams = [
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
    ];
    let changes = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            changes = await execute(insertStepSql, insertStepParams);
            break;
        } catch (error) {
            const isDuplicateStep = String(error?.code || '') === '23505'
                || /unique|duplicate|重复键|唯一约束/i.test(String(error?.message || ''))
                || /agent_steps|run_step|step_index|idx_agent_steps/i.test(String(error?.constraint || error?.message || ''));
            if (!isDuplicateStep || attempt >= 2) throw error;
            const next = await queryOne('SELECT COALESCE(MAX(step_index), 0) + 1 AS next_index FROM agent_steps WHERE run_id = ?', [runId]);
            insertStepParams[1] = Number(next?.next_index || 1);
            safeStepIndex = insertStepParams[1];
        }
    }
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
        assertRunNotCancelled: assertRunCanContinue,
        createAgentNotification,
        getAgentRunTitle,
        getRunMetadata,
        isApprovalGranted,
        setRunMetadata,
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
        verifyAgentOutcome: options => verifyAndRecordTaskOutcome({ ...options, setRunMetadata }),
        pollAgentControlMessages: async (runId, user, options) => {
            // 进程在 apply 后、ack 前崩溃时，先补发 ACK；状态已是 applied 的消息
            // 不会再次进入 claim/apply，从而保持恰好一次的业务应用语义。
            try { await acknowledgeAppliedAgentControlMessages(runId, user); } catch (_) {}
            const claimed = await claimAgentControlMessages(runId, user, options);
            const applied = claimed.length ? await applyAgentControlMessages(runId, user, claimed) : [];
            if (applied.length) {
                try { await acknowledgeAppliedAgentControlMessages(runId, user, applied); } catch (_) {}
            }
            return applied;
        }
    };
}

async function ensureTaskTransactionExecuting(run, user, taskContract = null) {
    const metadata = getRunMetadata(run);
    let transactionId = String(metadata.taskTransactionId || metadata.task_transaction_id || '').trim();
    let taskTransaction = transactionId ? await getTaskTransactionForUser(transactionId, user) : null;
    if (!taskTransaction) {
        taskTransaction = await createTaskTransaction({
            run,
            user,
            taskContract: taskContract || metadata.taskContract || metadata.task_contract || {},
            workspaceSnapshot: {
                kind: 'recovered_run_control_plane',
                runMode: run.run_mode || 'standard',
                recoveredAt: getBeijingTimestamp()
            }
        });
        transactionId = taskTransaction.id;
        await setRunMetadata(run.id, {
            taskTransactionId: transactionId,
            taskTransactionStatus: taskTransaction.status
        });
    }
    if (taskTransaction.status === 'planned') {
        taskTransaction = await transitionTaskTransaction(taskTransaction.id, user, 'executing');
        await setRunMetadata(run.id, { taskTransactionStatus: taskTransaction.status });
    }
    if (taskTransaction.status !== 'executing') {
        const error = new Error(`任务事务当前状态为 ${taskTransaction.status}，不能继续执行。`);
        error.code = 'AGENT_TASK_TRANSACTION_NOT_EXECUTABLE';
        error.status = 409;
        throw error;
    }
    return taskTransaction;
}

const { runAgent } = createAgentRunner({
    activeRunControllers,
    taskBudgetsBySignal,
    assertRunNotCancelled: assertRunCanContinue,
    isRunCancelled: runId => activeRunControllers.get(runId)?.signal?.aborted === true,
    assertRunUserActive,
    AGENT_DEFAULT_TIMEOUT_MS,
    AGENT_TOOL_TIMEOUT_MS,
    AGENT_AUTO_CONTINUE_ON_TIMEOUT,
    AGENT_AUTO_CONTINUE_ON_STEP_LIMIT,
    AGENT_MAX_AUTO_CONTINUATIONS,
    AGENT_MAX_TOTAL_RUNTIME_MS,
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
    resolveAgentPlanningThinking,
    resolveAgentRequestTimeoutMs,
    recordAgentModelUsage,
    normalizeToolInput,
    publishUserEvent,
    chooseModel,
    normalizeRouterStrategy,
    assessConfidence,
    isRecoverableModelProviderFailure,
    modelProviderFailureReason,
    pickFailoverModel,
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
    persistWorkingMemoryRevision,
    recordPromptInvocation,
        resolveActivePromptSection,
    buildAgentAuditFields,
    buildPlannerMessages,
    synthesizeFinalAnswer,
    isMissingFinalAnswer,
    withTimeout,
    buildVisionHistory,
    limitVisionImages,
    diagnoseError,
    buildAgentResumeContext,
    applyAgentControlMessages,
    acknowledgeAppliedAgentControlMessages,
    claimAgentControlMessages,
    listAppliedAgentControlMessages,
    approvalInputHash,
    maybePauseForApproval,
    isApprovalGranted,
    waitForWorkflowDelay,
    stableWorkflowDelayKey,
    setRunMetadata,
    recordRunRetryReason,
    calculateAgentRetryDelayMs,
    enqueueAgentRun,
    startAgentTraceSpan,
    finishAgentTraceSpan,
    syncAgentTraceFromRun,
    TERMINAL_STATUSES,
    ensureTaskTransactionExecuting,
    instanceId: AGENT_INSTANCE_ID,
    logger,
    getBeijingTimestamp,
    crypto
});

function enqueueAgentRun(runId, _user, options = {}) {
    getAgentQueue().enqueueRun(runId, options);
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
        const pendingCheckpoints = await query(`
            SELECT tool_name, input_hash, idempotent, operation_key, state
            FROM agent_run_checkpoints
            WHERE run_id = ? AND status = 'pending'
            ORDER BY step_index DESC, id DESC
        `, [run.id]);
        // 并发 DAG 可能留下多个 pending 检查点；不能只看最新一条，
        // 否则幂等兄弟节点会掩盖仍需重新审批的非幂等节点。
        const pending = pendingCheckpoints.find(checkpoint => !Boolean(checkpoint.idempotent)) || pendingCheckpoints[0] || null;
        const runMetadataRow = await queryOne('SELECT metadata FROM agent_runs WHERE id = ?', [run.id]);
        const safeResume = pendingCheckpoints.length > 0 && !pendingCheckpoints.some(checkpoint => !Boolean(checkpoint.idempotent));
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
    let expiredBrowserSessions = 0;
    let expiredVoiceSessions = 0;
    try {
        recoveredChatResults = await recoverChatAgentResults({ limit: 200 });
    } catch (error) {
        logger.error({ err: error.message }, '普通聊天 Agent 结果恢复扫描失败');
    }
    try {
        const { sweepExpiredAgentBrowserSessions } = require('../agent-browser-sessions');
        expiredBrowserSessions = await sweepExpiredAgentBrowserSessions();
    } catch (error) {
        logger.warn({ err: error.message }, '浏览器会话过期回收失败');
    }
    try {
        const { sweepExpiredAgentVoiceSessions } = require('../agent-voice-sessions');
        expiredVoiceSessions = await sweepExpiredAgentVoiceSessions();
    } catch (error) {
        logger.warn({ err: error.message }, '实时语音会话过期回收失败');
    }
    if (recoveredQueued > 0 || staleRunning.length > 0) {
        logger.info({ recoveredQueued, staleRunning: staleRunning.length, recoveredChatResults, expiredBrowserSessions, expiredVoiceSessions }, '智能体运行时异常任务恢复完成');
    } else {
        logger.debug({ recoveredQueued, staleRunning: staleRunning.length, recoveredChatResults, expiredBrowserSessions, expiredVoiceSessions }, '智能体运行时周期巡检完成');
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
const approveAgentTool = require('./approval-decisions').createApprovalDecision({
    getRunForUser, getRunMetadata, getBeijingTimestamp, updateRunCas, insertStep, listSteps,
    recordAgentEvent, createAgentNotification, getAgentRunTitle, approvalInputHash,
    buildAgentResumeContext, enqueueAgentRun
});
const { revokeApprovedAgentTool } = createApprovalRevocation({
    getRunForUser,
    getRunMetadata,
    updateRunCas,
    setRunMetadata,
    insertStep,
    listSteps,
    recordAgentEvent,
    createAgentNotification,
    getAgentRunTitle,
    getTimestamp: getBeijingTimestamp
});

async function getAgentRuntimeStatus(user = null) {
    const queueStatus = await getAgentQueue().getStatusAsync();
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
    return await queue.getStatusAsync();
}

const { createAgentRunFactory } = require('./run-creation');
const createAgentRun = createAgentRunFactory({
    assertRunUserActive,
    enqueueAgentRun,
    publishAgentRunEvent,
    recordFirstTaskCreated,
    createTaskTransaction,
    persistWorkingMemoryRevision
});

configureAgentChannelGateway({ createAgentRun });

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
    publishAgentRunEvent,
    query,
    updateRun,
    updateRunCas
});
const {
    assertRunNotCancelled,
    cancelAgentRun,
    pauseAgentRun,
    rerunAgentDagFromNode,
    rerunAgentRun,
    resumeAgentRun,
    softDeleteAgentRun
} = lifecycle;

/**
 * 执行边界同时检查本地取消信号与持久化运行归属：其他实例取消或接管后，
 * 当前执行器必须停止提交结果。数据库检查只作为边界确认，不替代本地信号。
 */
async function assertRunCanContinue(runId) {
    assertRunNotCancelled(runId);
    const row = await queryOne('SELECT status, locked_by FROM agent_runs WHERE id = ?', [runId]);
    if (row?.status === 'needs_input') {
        const error = new Error('任务已暂停或需要用户处理。');
        error.code = 'AGENT_RUN_PAUSED';
        activeRunControllers.get(runId)?.abort(error);
        throw error;
    }
    if (!row || ['cancelled', 'deleted'].includes(String(row.status || ''))) {
        const error = new Error('任务已停止。');
        error.code = 'AGENT_RUN_CANCELLED';
        activeRunControllers.get(runId)?.abort(error);
        throw error;
    }
    if (row.locked_by && String(row.locked_by) !== String(AGENT_INSTANCE_ID)) {
        const error = new Error('任务执行租约已由其他实例接管。');
        error.code = 'AGENT_RUN_LEASE_LOST';
        activeRunControllers.get(runId)?.abort(error);
        throw error;
    }
}

async function finalizeCommittedTaskTransactionRun(runId, user, transaction) {
    const run = await getRunForUser(runId, user);
    if (!run) return null;
    if (run.status !== 'awaiting_commit') return run;
    await updateRun(run.id, {
        status: 'completed',
        error_message: '',
        completed_at: getBeijingTimestamp(),
        updated_at: getBeijingTimestamp()
    });
    await setRunMetadata(run.id, {
        taskTransactionId: transaction.id,
        taskTransactionStatus: transaction.status,
        taskTransactionCommittedAt: transaction.committedAt || getBeijingTimestamp()
    });
    await createAgentNotification(user.id, run.id, 'completed', '任务已提交', getAgentRunTitle(run));
    return await getRunForUser(run.id, user);
}

async function finalizeRolledBackTaskTransactionRun(runId, user, transaction) {
    const run = await getRunForUser(runId, user);
    if (!run) return null;
    if (run.status !== 'awaiting_commit') return run;
    const rolledBack = transaction.status === 'rolled_back';
    const targetStatus = rolledBack ? 'cancelled' : 'needs_input';
    await updateRun(run.id, {
        status: targetStatus,
        error_message: rolledBack ? '用户放弃提交，已完成事务回滚。' : '任务事务补偿未完整完成，需要人工处理。',
        ...(rolledBack ? { cancelled_at: getBeijingTimestamp(), completed_at: getBeijingTimestamp() } : {}),
        updated_at: getBeijingTimestamp()
    });
    await setRunMetadata(run.id, {
        taskTransactionId: transaction.id,
        taskTransactionStatus: transaction.status,
        taskTransactionRolledBackAt: transaction.rolledBackAt || null
    });
    await createAgentNotification(user.id, run.id, rolledBack ? 'cancelled' : 'warning', rolledBack ? '任务事务已回滚' : '任务事务需要人工补偿', getAgentRunTitle(run));
    return await getRunForUser(run.id, user);
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
    runApprovalTimeouts,
    runProactiveGoals: () => runDueAgentGoals(),
    runChannelDeliveries: () => dispatchChannelDeliveries(50, { onDeadLetter: delivery => createAgentInboxEvent({ id: delivery.user_id }, { eventKey: `channel.dead_letter:${delivery.id}`, eventType: 'channel.dead_letter', sourceId: String(delivery.id), title: '渠道消息进入死信', body: delivery.last_error || '渠道投递失败次数超过上限。', risk: 'high', payload: { deliveryId: delivery.id, attempts: delivery.attempts } }) }),
    runLearningJobs: async () => {
        const jobs = await processAgentLearningJobs({ limit: 2 });
        await maybeArchiveStalePersonalExperiences();
        return jobs;
    },
    runSloMonitor: () => runAgentRuntimeSloMonitor()
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

// 新调用方按领域获取能力，避免继续把运行、工作流、产物和调度当作一个无边界平铺 API。
// 保留下面的平铺导出，确保历史扩展和桌面兼容层不发生破坏性变更。
const refreshAgentToolApproval = require('./approval-refresh').createApprovalRefresh({
    getRunForUser, getRunMetadata, updateRunCas, getTimestamp: getBeijingTimestamp, recordAgentEvent
});
const runs = {
    approveAgentTool, refreshAgentToolApproval, revokeApprovedAgentTool, cancelAgentRun, createAgentRun, pauseAgentRun, rerunAgentDagFromNode,
    rerunAgentRun, resumeAgentRun, runAgent, shouldPauseForApproval, softDeleteAgentRun,
    recoverAgentRuns, startAgentRecoveryRunner, finalizeCommittedTaskTransactionRun, finalizeRolledBackTaskTransactionRun
};
const schedules = {
    computeNextScheduleRun, createAgentSchedule, deleteAgentSchedule, listAgentSchedules,
    runAgentScheduleNow, runDueAgentSchedules, startAgentScheduleRunner, updateAgentSchedule
};
const templates = { createAgentTemplate, deleteAgentTemplate, listAgentTemplates, updateAgentTemplate };
const workflows = {
    createAgentWorkflow, deleteAgentWorkflow, diffAgentWorkflowVersions, getAgentWorkflowForUser,
    listAgentWorkflowShareOptions, listAgentWorkflowVersions, listAgentWorkflows,
    publishAgentWorkflowVersion, restoreAgentWorkflow, restoreAgentWorkflowVersion,
    updateAgentWorkflow, updateAgentWorkflowMetadata, updateAgentWorkflowSharing
};
const triggers = {
    createWorkflowTrigger, deleteWorkflowTrigger, listWorkflowTriggerEvents, listWorkflowTriggers, replayWorkflowTriggerEvent, rotateWorkflowTriggerToken,
    runDuePollingTriggers, updateWorkflowTrigger
};
const artifacts = {
    createAgentArtifactVersion, createStandaloneArtifact, diffAgentArtifactVersions, exportAgentRun,
    getAgentArtifactForUser, listAgentArtifactVersions, listAgentArtifacts, rollbackAgentArtifactVersion,
    saveAgentRunArtifact
};
const goals = {
    createAgentGoal, dispatchAgentGoalWebhook, getAgentGoal, listAgentGoals, recordAgentGoalRunOutcome,
    runAgentGoalNow, runDueAgentGoals, setAgentGoalStatus, updateAgentGoal
};
const monitoring = { getAgentMetrics, getAgentQueue, getAgentRuntimeStatus, syncAgentRuntimeConcurrency };
const notifications = { listAgentNotifications, markAgentNotificationRead };

module.exports = {
    artifacts,
    goals,
    monitoring,
    notifications,
    runs,
    schedules,
    templates,
    triggers,
    workflows
};
