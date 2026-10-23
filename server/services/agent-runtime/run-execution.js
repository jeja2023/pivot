const { sanitizeUserVisibleText } = require('../../llm');
const { requeueAgentRunAfterLeaseLoss } = require('./lease-loss');
const { buildToolTraceContext } = require('../tool-trace-context');
const { resolveRunLongTermMemory } = require('./run-memory');
const { continueRunFromCheckpoint: continueRunFromCheckpointHelper } = require('./run-continuation');
const { verifyTaskOutcome, taskVerificationFailureMessage } = require('../agent-verification');
const { inferTaskType } = require('../agent-model-quality');
const { recordWorkingObservation } = require('../agent-working-state');
const { plannerCoreSection } = require('../agent-prompt-registry');
const { attachWorkingMemoryOutputReference, persistWorkingMemoryOutput } = require('../agent-working-memory-artifacts');
const { createAgentRunErrorHandler } = require('./run-error-handler');
const { createRunPreparation } = require('./run-preparation');
const { createRunBudgetGuard, createRemainingModelRequestMs, createRunDeadlineTimer } = require('./run-budget-guard');
const { createRunFinalizer } = require('./run-finalizer');
const { executeAutomaticModelFailover } = require('./model-failover');
const { recordPlannerModelEvent } = require('./planning-lifecycle');
const { resolveApprovalKey } = require('../agent-approval-grants');

function createAgentRunner(deps = {}) {
const {
    activeRunControllers,
    taskBudgetsBySignal,
    assertRunNotCancelled,
    assertRunUserActive,
    isRunCancelled,
    AGENT_DEFAULT_TIMEOUT_MS,
    AGENT_TOOL_TIMEOUT_MS,
    AGENT_ANSWER_MIN_MAX_TOKENS,
    getRunForUser,
    getRunUser,
    getRunnableModelForUserAsync,
    compactToolOutputForModel,
    executeToolByName,
    findAgentToolByName,
    runAgentDag,
    isStreamingToolsEnabled,
    tryRunAgentStreaming,
    callModelText,
    resolveAgentPlanningThinking,
    resolveAgentRequestTimeoutMs,
    recordAgentModelUsage,
    normalizeToolInput,
    chooseModel,
    normalizeRouterStrategy,
    assessConfidence,
    isRecoverableModelProviderFailure = () => false,
    modelProviderFailureReason = error => String(error?.code || 'provider_failure'),
    pickFailoverModel = async () => null,
    pickEscalationModel,
    getModelEndpointRuntimeStatus,
    getAgentRuntimeDeps,
    execute,
    queryOne,
    updateRun,
    getRunStatus,
    insertStep,
    listSteps,
    getRunMetadata,
    getAgentRunTitle,
    formatToolList,
    listToolReliability,
    selectToolOrder,
    normalizeMaxSteps,
    normalizeRunMode,
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
    verifyAgentOutcome = options => verifyTaskOutcome(options),
    ensureTaskTransactionExecuting = async () => null,
    persistWorkingMemoryRevision = async () => null,
    recordPromptInvocation = async () => null,
    resolveActivePromptSection = async (_key, fallback, _user) => fallback,
    buildAgentAuditFields,
    buildPlannerMessages,
    synthesizeFinalAnswer,
    withTimeout,
    buildVisionHistory,
    limitVisionImages,
    diagnoseError,
    buildAgentResumeContext,
    acknowledgeAppliedAgentControlMessages = async () => [],
    applyAgentControlMessages,
    claimAgentControlMessages,
    listAppliedAgentControlMessages = async () => [],
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
    instanceId = '',
    logger,
    getBeijingTimestamp,
    } = deps;
    const continueRunFromCheckpoint = options => continueRunFromCheckpointHelper(options, deps);
    const loadRetryRow = runId => queryOne('SELECT retry_limit, retry_count FROM agent_runs WHERE id = ?', [runId]);
    const { handle: handleAgentRunError } = createAgentRunErrorHandler({
        requeueAgentRunAfterLeaseLoss, execute, getBeijingTimestamp, enqueueAgentRun, instanceId, logger,
        updateRun, getRunStatus, isRunCancelled, continueRunFromCheckpoint, withTimeout, synthesizeFinalAnswer,
        getRunMetadata, normalizePositiveInt, buildAgentResumeContext, calculateAgentRetryDelayMs,
        setRunMetadata, recordRunRetryReason, listSteps, insertStep, getRunUser, createAgentNotification,
        loadRetryRow, TERMINAL_STATUSES
    });
    const preparation = createRunPreparation({ formatToolList, listToolReliability, selectToolOrder, setRunMetadata, logger, verifyAgentOutcome });
    const { finalize: finalizeRun } = createRunFinalizer({ activeRunControllers, updateRun, getBeijingTimestamp, syncAgentTraceFromRun });
    async function runAgent(runId, user) {
    const runController = new AbortController();
    activeRunControllers.set(runId, runController);
    let deadlineTimer = null;
    let taskBudget = null;
    let runForSummary = null;
    let modelCfgForSummary = null;
    let observations = [];
    let lostExecutionLease = false;
    try {
        await assertRunUserActive(user);
        const run = await getRunForUser(runId, user, { includeDeleted: true });
        runForSummary = run;
        if (!run) throw new Error('任务不存在。');
        if (run.deleted_at || TERMINAL_STATUSES.has(run.status)) return;
        // 恢复路径先确认已持久化的控制应用；不会重放其指令。
        try { await acknowledgeAppliedAgentControlMessages(runId, user); } catch (error) {
            logger.warn({ runId, err: error.message }, '控制消息确认恢复失败，将在后续轮询重试');
        }
        await ensureAgentTrace(run, {
            runMode: run.run_mode,
            modelRouter: run.model_router,
            approvalPolicy: run.approval_policy
        });
        await assertRunNotCancelled(runId);
        const maxSteps = normalizeMaxSteps(run.max_steps, run.run_mode);
        const budgetConfig = parseJsonObject(run.budget_config) || {};
        const effectiveBudgetConfig = { ...budgetConfig };
        if (effectiveBudgetConfig.max_steps === undefined && effectiveBudgetConfig.maxSteps === undefined) {
            // Run-mode limits (deep/audit) may be higher than the historical
            // generic default. Keep the default budget aligned with this run.
            effectiveBudgetConfig.max_steps = maxSteps;
        }
        const normalizedBudget = normalizeTaskBudget(effectiveBudgetConfig);
        if (Number(run.max_token_budget) > 0) normalizedBudget.max_tokens_total = Math.min(normalizedBudget.max_tokens_total, Number(run.max_token_budget));
        const normalizedRunTimeout = normalizePositiveInt(run.timeout_ms, AGENT_DEFAULT_TIMEOUT_MS, 60000, 24 * 60 * 60 * 1000);
        const configuredRuntimeMs = Number.isFinite(normalizedBudget.max_runtime_seconds)
            ? Number(normalizedBudget.max_runtime_seconds) * 1000
            : Infinity;
        const deadline = Date.now() + Math.min(normalizedRunTimeout, configuredRuntimeMs);
        const remainingModelRequestMs = createRemainingModelRequestMs({ deadline, resolveAgentRequestTimeoutMs });
        taskBudget = new TaskBudget(normalizedBudget, {
            startedAt: Date.now(),
            enabled: true
        });
        // 同一任务从检查点恢复时，已付费的模型用量必须继续计入累计额度。
        taskBudget.counts.tokens_total = Math.max(Number(run.total_tokens) || 0, 0);
        const assertRunWithinBudget = createRunBudgetGuard({ deadline, taskBudget });
        taskBudgetsBySignal.set(runController.signal, taskBudget);
        deadlineTimer = createRunDeadlineTimer({ deadline, runController });
        const dagRun = normalizeRunMode(run.run_mode) === 'dag';
        const initialModelCfg = await getRunnableModelForUserAsync(run.model_id, user);
        if (!initialModelCfg && !dagRun) throw new Error('当前智能体运行无可用的模型端点。');
        // run.model_router 控制初始模型是固定使用、预先路由，还是后续升级。
        let modelCfg = initialModelCfg;
        modelCfgForSummary = modelCfg;
        const routerStrategy = normalizeRouterStrategy(run.model_router);
        if (initialModelCfg && routerStrategy !== 'fixed') {
            try {
                const routed = await chooseModel({
                    user,
                    strategy: routerStrategy,
                    hintModelId: run.model_id,
                    messages: [{ role: 'user', content: run.goal || '' }],
                    endpointStatusGetter: getModelEndpointRuntimeStatus,
                    taskType: inferTaskType(run)
                });
                if (!routed?.model) {
                    const error = new Error(routed?.reason || '没有满足当前任务能力与上下文要求的可用模型。');
                    error.code = 'MODEL_ROUTER_NO_COMPATIBLE_MODEL';
                    throw error;
                }
                if (routed && routed.model && routed.model.id !== initialModelCfg.id) {
                    modelCfg = routed.model;
                    modelCfgForSummary = modelCfg;
                    await execute('UPDATE agent_runs SET chosen_model_id = ?, updated_at = ? WHERE id = ?', [
                        modelCfg.id, getBeijingTimestamp(), runId
                    ]);
                    await insertStep(runId, (await listSteps(runId)).length + 1, {
                        type: 'control',
                        title: `模型路由选择：${routerStrategy}`,
                        output: {
                            strategy: routerStrategy, chosenModelId: modelCfg.id, chosenModelName: modelCfg.name || modelCfg.model_name || '',
                            reason: routed.reason || '', candidatesCount: routed.candidatesCount || 0, qualityProfile: routed.qualityProfile || null
                        }
                    });
                    logger.info({ runId, strategy: routerStrategy, originalModelId: initialModelCfg.id, chosenModelId: modelCfg.id, reason: routed.reason }, '智能体模型路由已选择模型');
                }
                await recordAgentTraceSpan(runId, {
                    type: 'routing',
                    name: '模型路由',
                    input: { strategy: routerStrategy, requestedModelId: initialModelCfg.id },
                    output: {
                        chosenModelId: modelCfg.id, chosenModelName: modelCfg.name || modelCfg.model_name || '',
                        reason: routed.reason || '', candidatesCount: routed.candidatesCount || 0, qualityProfile: routed.qualityProfile || null
                    },
                    details: { strategy: routerStrategy, taskType: inferTaskType(run) }
                });
            } catch (routerErr) {
                // “没有兼容模型”不是路由器暂时故障；继续使用原模型会把包含
                // 图片或超长上下文的任务发送给明确不兼容的端点。
                if (routerErr?.code === 'MODEL_ROUTER_NO_COMPATIBLE_MODEL') throw routerErr;
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

        let runtimeMetadata = getRunMetadata(run);
        if (runtimeMetadata.chatBridge?.executionProfile === 'knowledge_qa') {
            modelCfg = { ...modelCfg, max_input_tokens: Math.min(Number(modelCfg.max_input_tokens) > 0 ? Number(modelCfg.max_input_tokens) : Infinity, 24576) };
            modelCfgForSummary = modelCfg;
        }
        const {
            longTermMemoryContext,
            recordActualMemoryUsage,
            recordPlannerMemoryUsage
        } = await resolveRunLongTermMemory({
            run,
            user,
            modelCfg,
            contextConfig: parseJsonObject(run.context_config) || {},
            logger
        });
        runtimeMetadata = getRunMetadata(run);
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
        observations = [
            ...(Array.isArray(resumeContext.observations) ? resumeContext.observations : []),
            ...(Array.isArray(resumeContext.recentFailures) ? resumeContext.recentFailures : [])
        ].slice(-25);
        const appliedControlMessages = await listAppliedAgentControlMessages(runId, user, { limit: 20 }) || [];
        const observedControlMessageIds = new Set(appliedControlMessages.map(message => String(message.message_id || '')));
        observations.push(...appliedControlMessages.map(message => ({
            type: 'agent_control',
            messageId: message.message_id,
            messageType: message.message_type,
            fromRunId: message.from_run_id || '',
            payload: message.payload,
            restored: true
        })));
        observations = observations.slice(-45);
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
        const chatBridge = runtimeMetadata.chatBridge;
        const preparedTools = await preparation.prepareTools({ runId, user, run, runtimeMetadata, chatBridge });
        const { toolList, plannerToolList, toolDiscoveryState, progressivePlannerToolNames } = preparedTools;
        let taskContract = runtimeMetadata.taskContract || runtimeMetadata.task_contract || null;
        let taskWorkingState = runtimeMetadata.workingState || null;
        const taskTransaction = await ensureTaskTransactionExecuting(run, user, taskContract);
        const taskTransactionId = String(taskTransaction?.id || runtimeMetadata.taskTransactionId || '').trim();
        if (taskTransactionId) run.metadata = { ...getRunMetadata(run), taskTransactionId };
        const plannerChatContext = preparation.buildPlannerContext({
            chatBridge, plannerChatHistory, plannerCurrentMessage, longTermMemoryContext, runtimeMetadata, taskWorkingState
        });
        const verifyOutcome = preparation.createOutcomeVerifier({
            runId, run, user, getTaskContract: () => taskContract, getObservations: () => observations, signal: runController.signal, budget: taskBudget
        });
        await assertRunNotCancelled(runId);
        const startedAt = getBeijingTimestamp();
        await updateRun(runId, {
            status: 'planning',
            started_at: run.started_at || startedAt,
            last_heartbeat_at: startedAt,
            updated_at: startedAt
        });

        if (dagRun) {
            await assertRunNotCancelled(runId);
            await updateRun(runId, { status: 'executing', updated_at: getBeijingTimestamp() });
            await runAgentDag({ run, user, modelCfg, toolList, deadline, assertRunWithinBudget, taskTransactionId }, getAgentRuntimeDeps(runController.signal));
            return;
        }

        // 启用时优先使用流式函数调用，让模型可直接发出 tool_calls。
        // 如果流式调用未完成，下方 JSON 规划器会基于已收集的观察继续执行。
        let roundsUsed = Math.max(
            Number(run.resume_from_step || 0) || 0,
            Number(resumeContext.latestStepIndex || 0) || 0,
            0
        );
        let stopReason = '';
        if (isStreamingToolsEnabled(modelCfg)) {
            const streamingDeps = getAgentRuntimeDeps(runController.signal, taskBudget);
            if (chatBridge || longTermMemoryContext) {
                streamingDeps.synthesizeFinalAnswer = (streamModelCfg, streamGoal, streamObservations, streamUser, streamRunId, options = {}) => (
                    synthesizeFinalAnswer(streamModelCfg, streamGoal, streamObservations, streamUser, streamRunId, {
                        ...options,
                        ...plannerChatContext
                    })
                );
            }
            await recordActualMemoryUsage();
            const streamingResult = await tryRunAgentStreaming({
                run,
                user,
                modelCfg,
                toolList,
                plannerToolList,
                toolDiscoveryState,
                plannerToolNames: progressivePlannerToolNames,
                runId,
                deadline,
                assertRunWithinBudget,
                assertRunNotCancelled,
                observations,
                taskTransactionId,
                chatContext: plannerChatContext
            }, streamingDeps);
            if (streamingResult?.completed) return;
            roundsUsed = Math.max(Number(streamingResult?.roundsUsed || 0), roundsUsed, 0);
            if (streamingResult?.stepLimitReached) {
                const stepLimitError = Object.assign(new Error(`当前时间片已执行 ${maxSteps} 轮`), { code: 'AGENT_STEP_LIMIT' });
                if (await continueRunFromCheckpoint({ run, runId, user, error: stepLimitError, reason: 'step_limit' })) return;
                stopReason = stepLimitError.message;
            }
            // 流式调用已产生部分工作但未完成，继续走 JSON 规划器路径。
        }

        let previousWorldState = null;
        let lastOperationSignature = '';
        let stagnantRounds = 0;
        const sliceEndStep = stopReason ? roundsUsed : roundsUsed + maxSteps;
        let lastExecutedStep = roundsUsed;
        for (let step = roundsUsed + 1; step <= sliceEndStep; step += 1) {
            lastExecutedStep = step;
            taskBudget.consumeStep();
            await updateRun(runId, { status: 'planning', updated_at: getBeijingTimestamp() });
            assertRunWithinBudget();
            await assertRunNotCancelled(runId);
            await updateRun(runId, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
            const claimedControlMessages = await claimAgentControlMessages(runId, user, { limit: 20 });
            const controlMessages = claimedControlMessages.length && typeof applyAgentControlMessages === 'function'
                ? await applyAgentControlMessages(runId, user, claimedControlMessages)
                : [];
            if (controlMessages.length) {
                try { await acknowledgeAppliedAgentControlMessages(runId, user, controlMessages); } catch (error) {
                    logger.warn({ runId, err: error.message }, '控制消息确认失败，将在后续轮询重试');
                }
            }
            if (controlMessages.length) {
                const freshMessages = controlMessages.filter(message => !observedControlMessageIds.has(String(message.message_id || '')));
                freshMessages.forEach(message => observedControlMessageIds.add(String(message.message_id || '')));
                taskWorkingState = freshMessages.at(-1)?.workingState || taskWorkingState;
                taskContract = freshMessages.at(-1)?.taskContract || taskContract;
                observations.push(...freshMessages.map(message => ({
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
                contextConfig: { ...(parseJsonObject(run.context_config) || {}), taskWorkingState },
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
                    stepContext,
                    entrypoint: 'agent',
                    payload: buildAgentAuditFields(stepContext, { entrypoint: 'agent', purpose: 'agent_context_captured' }),
                    eventKey: stepContext.contextHash
                });
            } catch (eventError) {
                logger.warn({ runId, err: eventError.message }, 'Agent StepContext 事件写入失败');
            }
            const plannerContextConfig = {
                ...(parseJsonObject(run.context_config) || {}),
                agentProfileContext: getRunMetadata(run).agentProfileContext || '',
                feedbackSignals: getRunMetadata(run).feedbackSignals || null,
                skillTitle: getRunMetadata(run).skillTitle || '',
                skillInstructions: getRunMetadata(run).skillInstructions || '',
                longTermMemoryContext,
                taskWorkingState,
                chatHistory: plannerChatHistory,
                chatAgent: runtimeMetadata.chatBridge
                    ? { ...runtimeMetadata.chatBridge, memoryContext: longTermMemoryContext, currentMessage: plannerCurrentMessage }
                    : null
            };
            const activePlannerCore = await resolveActivePromptSection('agent_planner_core', plannerCoreSection(), user);
            const plannerMessages = buildPlannerMessages(run.goal, plannerToolList, observations, run.run_mode, plannerContextConfig, modelCfg, stepContext.worldState, stepContext.worldStateInjection, activePlannerCore);
            const semanticCompaction = plannerMessages.contextCompaction;
            if (semanticCompaction?.applied) {
                // 压缩本身是影响后续模型决策的运行时边界，必须留下可关联的审计；
                // 只记层级、Token 与引用数量，绝不把历史正文、Working Memory 正文或
                // CAS 引用写入事件日志。
                const compactionAudit = {
                    targetTokens: Number(semanticCompaction.targetTokens || 0),
                    inputTokensBefore: Number(semanticCompaction.inputTokensBefore || 0),
                    inputTokensAfter: Number(semanticCompaction.inputTokensAfter || 0),
                    levelOne: {
                        applied: Boolean(semanticCompaction.levelOne?.applied),
                        evidenceCards: Number(semanticCompaction.levelOne?.evidenceCards || 0),
                        referencesRetained: Number(semanticCompaction.levelOne?.referencesRetained || 0)
                    },
                    levelTwo: { applied: Boolean(semanticCompaction.levelTwo?.applied) },
                    levelThree: {
                        applied: Boolean(semanticCompaction.levelThree?.applied),
                        summarizedMessages: Number(semanticCompaction.levelThree?.summarizedMessages || 0)
                    },
                    retained: {
                        constraints: Array.isArray(semanticCompaction.retention?.constraintIds) ? semanticCompaction.retention.constraintIds.length : 0,
                        pending: Array.isArray(semanticCompaction.retention?.pendingIds) ? semanticCompaction.retention.pendingIds.length : 0,
                        evidenceReferences: Array.isArray(semanticCompaction.retention?.evidenceRefs) ? semanticCompaction.retention.evidenceRefs.length : 0,
                        constraintRetentionRate: Number(semanticCompaction.retention?.constraintRetentionRate ?? 0),
                        pendingRetentionRate: Number(semanticCompaction.retention?.pendingRetentionRate ?? 0),
                        evidenceReferenceRetentionRate: Number(semanticCompaction.retention?.evidenceReferenceRetentionRate ?? 0),
                        hardFieldLoss: Boolean(semanticCompaction.retention?.blockingLoss)
                    }
                };
                try {
                    await recordAgentEvent({
                        runId,
                        userId: user.id,
                        turnId: stepContext.turnId,
                        stepIndex: step,
                        type: 'context.compacted',
                        payload: {
                            ...buildAgentAuditFields(stepContext, { entrypoint: 'agent', purpose: 'agent_semantic_context_compacted' }),
                            compaction: compactionAudit
                        },
                        eventKey: `${stepContext.contextHash}:semantic_context_compacted`
                    });
                } catch (eventError) {
                    logger.warn({ runId, step, err: eventError.message }, 'Agent 语义上下文压缩审计写入失败');
                }
                try {
                    await persistWorkingMemoryRevision({
                        run, user, state: taskWorkingState, taskContract, reason: 'context_compacted'
                    });
                } catch (revisionError) {
                    logger.warn({ runId, step, err: revisionError.message }, 'Agent 语义上下文压缩工作记忆修订失败');
                }
            }
            try {
                await recordPromptInvocation({ runId, user, source: 'agent_planner', manifest: plannerMessages.promptManifest || null });
            } catch (promptAuditError) {
                logger.warn({ runId, step, err: promptAuditError.message }, 'Agent Prompt Section 审计写入失败');
            }
            await recordPlannerMemoryUsage(plannerMessages);
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
            let plannedUsageResult = null;
            try {
                await recordPlannerModelEvent('requested', { runId, user, turnId: stepContext.turnId, step, stepContext, model: modelCfg, purpose: 'agent_planner_requested', messageCount: plannerMessages.length });
                const usageRef = {};
                // 规划一步可能直接内联 {"action":"final","answer":"…"} 给出完整答案，
                // 那段 answer 同样受本次调用的输出预算限制，因此按最终答案的下限给足。
                const modelRequestTimeoutMs = remainingModelRequestMs();
                plannedText = await withTimeout(signal => callModelText(modelCfg, plannerMessages, {
                    user,
                    signal,
                    usageRef,
                    minMaxTokens: AGENT_ANSWER_MIN_MAX_TOKENS,
                    enableThinking: resolveAgentPlanningThinking(modelCfg),
                    timeoutMs: modelRequestTimeoutMs
                }), modelRequestTimeoutMs, '智能体规划', { signal: runController.signal });
                plannedTextUsageRef = usageRef;
                if (usageRef.truncated) {
                    logger.warn({
                        runId,
                        step,
                        maxTokens: usageRef.maxTokens,
                        outputTokens: usageRef.usage?.completion_tokens ?? usageRef.usage?.output_tokens ?? null
                    }, 'Agent 规划输出因预算耗尽被截断，本步结果可能不完整');
                }
                await recordPlannerModelEvent('completed', { runId, user, turnId: stepContext.turnId, step, stepContext, model: modelCfg, purpose: 'agent_planner_completed', responseLength: String(plannedText || '').length });
                await finishAgentTraceSpan(plannerSpanId, {
                    output: { responseLength: String(plannedText || '').length },
                    durationMs: Date.now() - plannerStartedAt,
                    contextHash: stepContext.contextHash
                });
            } catch (plannerError) {
                await recordPlannerModelEvent('failed', { runId, user, turnId: stepContext.turnId, step, stepContext, model: modelCfg, purpose: 'agent_planner_failed', error: plannerError });
                await finishAgentTraceSpan(plannerSpanId, {
                    status: 'error',
                    errorMessage: plannerError.message,
                    durationMs: Date.now() - plannerStartedAt,
                    contextHash: stepContext.contextHash
                });
                // 固定模型与非可恢复错误不能降级；可恢复的供应方故障最多只切换一次。
                const failover = await executeAutomaticModelFailover({
                    routerStrategy,
                    error: plannerError,
                    user,
                    currentModel: modelCfg,
                    messages: plannerMessages,
                    endpointStatusGetter: getModelEndpointRuntimeStatus,
                    isRecoverableModelProviderFailure,
                    modelProviderFailureReason,
                    pickFailoverModel,
                    runId,
                    step,
                    turnId: stepContext.turnId,
                    contextHash: stepContext.contextHash,
                    stepContext,
                    signal: runController.signal,
                    getTimestamp: getBeijingTimestamp,
                    updateRun,
                    listSteps,
                    insertStep,
                    recordAgentTraceSpan,
                    startAgentTraceSpan,
                    finishAgentTraceSpan,
                    recordAgentEvent,
                    buildAgentAuditFields,
                    callModelText,
                    remainingModelRequestMs,
                    resolveAgentPlanningThinking,
                    withTimeout,
                    minMaxTokens: AGENT_ANSWER_MIN_MAX_TOKENS,
                    recordPlannerModelEvent
                });
                if (!failover) throw plannerError;
                modelCfg = failover.model;
                modelCfgForSummary = failover.model;
                plannedText = failover.plannedText;
                plannedTextUsageRef = failover.usageRef;
            }
            plannedUsageResult = await recordAgentModelUsage(user, modelCfg, plannerMessages, plannedText, 'agent_planner', runId, {
                budget: taskBudget,
                usageRef: plannedTextUsageRef,
                allowBudgetExceeded: true
            });
            if (!plannedUsageResult?.budgetExceeded) assertRunWithinBudget();
            await assertRunNotCancelled(runId);
            const plan = parseJsonObject(plannedText) || {};
            await insertStep(runId, step, {
                type: 'plan',
                title: plan.thought || '智能体规划',
                input: { goal: run.goal },
                output: plan,
                durationMs: Date.now() - plannerStartedAt,
                contextHash: stepContext.contextHash
            });

            if (plannedUsageResult?.budgetExceeded) {
                const answer = sanitizeUserVisibleText(plan.answer) || (observations.length
                    ? `已保留 ${observations.length} 项工具执行记录，可在任务详情查看；当前额度不足以继续生成总结。`
                    : '当前额度已用完，本次尚未生成可用答案。');
                const warning = '已达到总 Token 预算，任务已停止继续调用工具。';
                await updateRun(runId, {
                    status: 'completed_with_errors',
                    final_answer: `注意：${warning}\n\n${answer}`,
                    error_message: warning,
                    completed_at: getBeijingTimestamp(),
                    last_heartbeat_at: getBeijingTimestamp(),
                    updated_at: getBeijingTimestamp()
                });
                await createAgentNotification(user.id, runId, 'warning', '任务已生成部分结果', warning);
                return;
            }

            if (plan.action === 'final' || !plan.tool) {
                const answer = sanitizeUserVisibleText(plan.answer) || await synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId, {
                    signal: runController.signal,
                    budget: taskBudget,
                    ...plannerChatContext
                });
                await assertRunNotCancelled(runId);
                await updateRun(runId, { status: 'verifying', updated_at: getBeijingTimestamp() });
                const verification = await verifyOutcome(answer, false, '', { allowed: true, remainingSteps: sliceEndStep - step });
                await assertRunNotCancelled(runId);
                if (verification.repair?.allowed) {
                    taskContract = verification.taskContract;
                    run.metadata = { ...getRunMetadata(run), taskContract };
                    observations.push({ type: 'verification_repair', step, tool: 'task.verification', output: {
                        executed: false, message: require('../agent-verification-repair').buildVerificationRepairMessage(verification)
                    } });
                    continue;
                }
                const awaitingCommit = verification.taskTransaction?.status === 'awaiting_commit';
                const finalStatus = awaitingCommit
                    ? 'awaiting_commit'
                    : verification.outcomeStatus === 'verified'
                        ? 'completed'
                    : verification.outcomeStatus === 'partial' ? 'partial' : 'needs_input';
                const verified = finalStatus === 'completed';
                const verificationError = verified
                    ? ''
                    : awaitingCommit
                        ? '任务结果已验证，仍有外部副作用等待提交。'
                    : taskVerificationFailureMessage(verification);
                await updateRun(runId, {
                    status: finalStatus,
                    final_answer: answer,
                    error_message: verificationError,
                    ...(['needs_input', 'awaiting_commit'].includes(finalStatus) ? {} : { completed_at: getBeijingTimestamp() }),
                    last_heartbeat_at: getBeijingTimestamp(),
                    updated_at: getBeijingTimestamp()
                });
                await createAgentNotification(user.id, runId, verified ? 'completed' : 'warning', verified ? '任务运行完成' : awaitingCommit ? '任务等待提交' : '任务结果有待处理事项', getAgentRunTitle(run));
                return;
            }

            const startedAt = Date.now();
            const effectivePlanInput = normalizeToolInput(plan.tool, plan.input || {}, {
                ...run,
                model_id: run.model_id ?? modelCfg?.id,
                chosen_model_id: run.chosen_model_id ?? modelCfg?.id
            });
            let progressiveExecution; try {
                progressiveExecution = await require('../agent-progressive-execution').resolveProgressiveExecution({ toolName: plan.tool, input: effectivePlanInput, user, toolList, state: toolDiscoveryState, run });
            } catch (toolResolutionError) {
                observations.push({ step, tool: plan.tool, input: effectivePlanInput, error: toolResolutionError.message });
                await insertStep(runId, step, { type: 'tool', title: `工具发现未完成：${plan.tool}`, toolName: plan.tool, input: effectivePlanInput, errorMessage: toolResolutionError.message, status: 'error', contextHash: stepContext.contextHash });
                continue;
            }
            const operationSignature = `${progressiveExecution.approvalToolName}:${approvalInputHash(progressiveExecution.approvalInput)}`;
            stagnantRounds = operationSignature === lastOperationSignature ? stagnantRounds + 1 : 1;
            lastOperationSignature = operationSignature;
            if (stagnantRounds >= 3) {
                stopReason = `检测到工具 ${plan.tool} 连续重复调用且没有进展，已提前停止。`;
                observations.push({ step, tool: plan.tool, input: effectivePlanInput, error: stopReason });
                await insertStep(runId, step, {
                    type: 'control',
                    title: '检测到重复工具调用',
                    input: effectivePlanInput,
                    output: { tool: plan.tool, message: stopReason },
                    errorMessage: stopReason,
                    status: 'error',
                    contextHash: stepContext.contextHash
                });
                break;
            }
            try {
                await updateRun(runId, { status: 'executing', updated_at: getBeijingTimestamp() });
                await assertRunUserActive(user);
                await assertRunNotCancelled(runId);
                assertRunWithinBudget();
                await updateRun(runId, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
                const selectedTool = progressiveExecution.approvalTool;
                const approvalKey = resolveApprovalKey(run, progressiveExecution.approvalToolName, progressiveExecution.approvalInput, `${runId}:${step}:${progressiveExecution.approvalToolName}`);
                if (await maybePauseForApproval(run, selectedTool, progressiveExecution.approvalInput, approvalKey)) return;
                const toolContext = {
                    run,
                    modelCfg,
                    autonomous: true,
                    stepId: `${runId}:${step}`,
                    stepIndex: step,
                    stepContext,
                    contextHash: stepContext.contextHash,
                    traceContext: buildToolTraceContext({ runId, spanId: `${runId}:${step}`, requestId: stepContext?.requestId || '' }),
                    budget: taskBudget,
                    taskTransactionId,
                    approvalGranted: isApprovalGranted(run, progressiveExecution.approvalToolName, approvalKey, progressiveExecution.approvalInput),
                    approvalKey,
                    allowApproval: isApprovalGranted(run, progressiveExecution.approvalToolName, approvalKey, progressiveExecution.approvalInput),
                    toolDiscoveryState,
                    discoveryRequired: progressiveExecution.discoveryRequired,
                    plannerToolNames: progressivePlannerToolNames,
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
                await assertRunNotCancelled(runId);
                assertRunWithinBudget();
                let compactOutput = compactToolOutputForModel(output, modelCfg);
                try {
                    const reference = compactOutput && typeof compactOutput === 'object' && (compactOutput.__partial === true || compactOutput.structuredContent?.__partial === true)
                        ? await persistWorkingMemoryOutput(output, user, { tenantId: run.tenant_id || user.tenant_id || user.tenantId, force: true })
                        : null;
                    if (reference) compactOutput = attachWorkingMemoryOutputReference(compactOutput, reference);
                } catch (error) {
                    // 原文存储不可用时不能把摘要伪装为可完整追溯；仍保留工具事实并让验收看到缺口。
                    if (compactOutput && typeof compactOutput === 'object' && !Array.isArray(compactOutput)) {
                        compactOutput = { ...compactOutput, rawOutputStorageError: String(error.message || '原文存储失败').slice(0, 240) };
                    }
                }
                await updateRun(runId, { status: 'observing', updated_at: getBeijingTimestamp() });
                observations.push({
                    step,
                    tool: plan.tool,
                    input: effectivePlanInput,
                    output: compactOutput
                });
                taskWorkingState = recordWorkingObservation(taskWorkingState, { tool: plan.tool, output: compactOutput }, taskContract, run.goal);
                await setRunMetadata(runId, { taskContract, workingState: taskWorkingState });
                await persistWorkingMemoryRevision({
                    run, user, state: taskWorkingState, taskContract, reason: 'tool_observation'
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
                        contextHash: stepContext.contextHash,
                        stepContext,
                        entrypoint: 'agent',
                        tenantId: user.tenant_id || user.tenantId || null,
                        toolVersion: findAgentToolByName(plan.tool, toolList)?.version || findAgentToolByName(plan.tool, toolList)?.tool_version || '',
                        taskType: run.run_mode || ''
                    });
                } catch (auditError) {
                    throw auditError;
                }
                taskBudget.recordSuccess();
            } catch (toolErr) {
                if (toolErr.code === 'AGENT_APPROVAL_REQUIRED' || toolErr.code === 'AGENT_RUN_CANCELLED' || isRunCancelled(runId)) throw toolErr;
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
                        policyDecision: ['AGENT_POLICY_DENIED', 'TOOL_POLICY_DENIED'].includes(toolErr.code) ? 'denied' : 'allow',
                        status: 'error',
                        errorCategory: diagnosis.category,
                        errorMessage: toolErr.message,
                        durationMs: Date.now() - startedAt,
                        contextHash: stepContext.contextHash,
                        stepContext,
                        entrypoint: 'agent',
                        tenantId: user.tenant_id || user.tenantId || null,
                        toolVersion: findAgentToolByName(plan.tool, toolList)?.version || findAgentToolByName(plan.tool, toolList)?.tool_version || '',
                        taskType: run.run_mode || ''
                    });
                } catch (auditError) {
                    auditError.cause = toolErr;
                    throw auditError;
                }
                if (step < sliceEndStep) await updateRun(runId, { status: 'replanning', updated_at: getBeijingTimestamp() });
            }
        }

        await assertRunNotCancelled(runId);
        assertRunWithinBudget();
        if (!stopReason && lastExecutedStep >= sliceEndStep) {
            const stepLimitError = Object.assign(new Error(`当前时间片已执行 ${maxSteps} 轮`), { code: 'AGENT_STEP_LIMIT' });
            if (await continueRunFromCheckpoint({ run, runId, user, error: stepLimitError, reason: 'step_limit' })) return;
        }
        const limitMessage = stopReason || `已达到最大执行轮次 ${maxSteps}，结果可能不完整。`;
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
            const finalSummaryTimeoutMs = remainingModelRequestMs();
            answer = await withTimeout(signal => synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId, {
                signal,
                budget: taskBudget,
                allowBudgetExceeded: true,
                timeoutMs: finalSummaryTimeoutMs,
                ...plannerChatContext
            }), finalSummaryTimeoutMs, 'final summary', { signal: runController.signal });
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
                        const escalatedSummaryTimeoutMs = remainingModelRequestMs();
                        answer = await withTimeout(signal => synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId, {
                            signal,
                            budget: taskBudget,
                            allowBudgetExceeded: true,
                            timeoutMs: escalatedSummaryTimeoutMs,
                            ...plannerChatContext
                        }), escalatedSummaryTimeoutMs, 'escalated final summary', { signal: runController.signal });
                    }
                } catch (escErr) {
                    logger.warn({ runId, err: escErr.message }, '自动升级失败，保留首次回答');
                }
            }
        }
        await assertRunNotCancelled(runId);
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
        await handleAgentRunError(e, {
            runId, user, runForSummary, modelCfgForSummary, observations, taskBudget,
            markExecutionLeaseLost: () => { lostExecutionLease = true; }
        });

    } finally {
        await finalizeRun({ runId, runController, deadlineTimer, taskBudget, lostExecutionLease });
    }
}

    return { runAgent };
}

module.exports = { createAgentRunner };
