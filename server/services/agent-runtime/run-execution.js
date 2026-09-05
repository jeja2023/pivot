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
    recordAgentModelUsage,
    normalizeToolInput,
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
    buildAgentAuditFields,
    buildPlannerMessages,
    synthesizeFinalAnswer,
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
} = deps;

async function runAgent(runId, user) {
    const runController = new AbortController();
    activeRunControllers.set(runId, runController);
    let deadlineTimer = null;
    let taskBudget = null;
    let runForSummary = null;
    let modelCfgForSummary = null;
    let observations = [];
    try {
        await assertRunUserActive(user);
        const run = await getRunForUser(runId, user, { includeDeleted: true });
        runForSummary = run;
        if (!run) throw new Error('任务不存在。');
        if (run.deleted_at || TERMINAL_STATUSES.has(run.status)) return;
        await ensureAgentTrace(run, {
            runMode: run.run_mode,
            modelRouter: run.model_router,
            approvalPolicy: run.approval_policy
        });
        assertRunNotCancelled(runId);
        const maxSteps = normalizeMaxSteps(run.max_steps, run.run_mode);
        const budgetConfig = parseJsonObject(run.budget_config) || {};
        const effectiveBudgetConfig = { ...budgetConfig };
        if (effectiveBudgetConfig.max_steps === undefined && effectiveBudgetConfig.maxSteps === undefined) {
            // Run-mode limits (deep/audit) may be higher than the historical
            // generic default. Keep the default budget aligned with this run.
            effectiveBudgetConfig.max_steps = maxSteps;
        }
        const normalizedBudget = normalizeTaskBudget(effectiveBudgetConfig);
        const normalizedRunTimeout = normalizePositiveInt(run.timeout_ms, AGENT_DEFAULT_TIMEOUT_MS, 60000, 24 * 60 * 60 * 1000);
        const configuredRuntimeMs = Number.isFinite(normalizedBudget.max_runtime_seconds)
            ? Number(normalizedBudget.max_runtime_seconds) * 1000
            : Infinity;
        const deadline = Date.now() + Math.min(normalizedRunTimeout, configuredRuntimeMs);
        taskBudget = new TaskBudget(normalizedBudget, {
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
        modelCfgForSummary = modelCfg;
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
                    modelCfgForSummary = modelCfg;
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
        observations = [
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
        try {
            const reliability = await listToolReliability(user, { days: 30, persist: false });
            toolList = selectToolOrder(toolList, reliability.signals);
            await setRunMetadata(runId, { toolReliabilityWindow: { days: reliability.days, minSampleCount: reliability.minSampleCount, signals: reliability.signals.slice(0, 100) } });
        } catch (reliabilityError) {
            logger.warn({ runId, err: reliabilityError.message }, '工具可靠性信号加载失败，继续固定排序');
        }
        const chatBridge = runtimeMetadata.chatBridge;
        const plannerChatContext = chatBridge
            ? { chatHistory: plannerChatHistory, chatAgent: { ...chatBridge, currentMessage: plannerCurrentMessage }, agentProfileContext: runtimeMetadata.agentProfileContext || '', feedbackSignals: runtimeMetadata.feedbackSignals || null, skillTitle: runtimeMetadata.skillTitle || '', skillInstructions: runtimeMetadata.skillInstructions || '' }
            : { agentProfileContext: runtimeMetadata.agentProfileContext || '', feedbackSignals: runtimeMetadata.feedbackSignals || null, skillTitle: runtimeMetadata.skillTitle || '', skillInstructions: runtimeMetadata.skillInstructions || '' };
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
        let roundsUsed = Math.max(
            Number(run.resume_from_step || 0) || 0,
            Number(resumeContext.latestStepIndex || 0) || 0,
            0
        );
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
        let lastOperationSignature = '';
        let stagnantRounds = 0;
        let stopReason = '';
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
            let plannedUsageResult = null;
            try {
                try {
                    await recordAgentEvent({
                        runId,
                        userId: user.id,
                        turnId: stepContext.turnId,
                        stepIndex: step,
                        type: 'model.requested',
                        payload: { ...buildAgentAuditFields(stepContext, { entrypoint: 'agent', purpose: 'agent_planner_requested' }), messageCount: plannerMessages.length },
                        eventKey: `model:${stepContext.contextHash}:requested`
                    });
                } catch (_) {}
                const usageRef = {};
                // 规划一步可能直接内联 {"action":"final","answer":"…"} 给出完整答案，
                // 那段 answer 同样受本次调用的输出预算限制，因此按最终答案的下限给足。
                plannedText = await withTimeout(signal => callModelText(modelCfg, plannerMessages, { user, signal, usageRef, minMaxTokens: AGENT_ANSWER_MIN_MAX_TOKENS }), Math.min(180000, Math.max(deadline - Date.now(), 1000)), '智能体规划', { signal: runController.signal });
                plannedTextUsageRef = usageRef;
                if (usageRef.truncated) {
                    logger.warn({
                        runId,
                        step,
                        maxTokens: usageRef.maxTokens,
                        outputTokens: usageRef.usage?.completion_tokens ?? usageRef.usage?.output_tokens ?? null
                    }, 'Agent 规划输出因预算耗尽被截断，本步结果可能不完整');
                }
                try {
                    await recordAgentEvent({
                        runId,
                        userId: user.id,
                        turnId: stepContext.turnId,
                        stepIndex: step,
                        type: 'model.completed',
                        payload: { ...buildAgentAuditFields(stepContext, { entrypoint: 'agent', purpose: 'agent_planner_completed' }), responseLength: String(plannedText || '').length },
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
                        payload: { ...buildAgentAuditFields(stepContext, { entrypoint: 'agent', purpose: 'agent_planner_failed' }), errorCode: plannerError.code || '', errorMessage: plannerError.message },
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
            plannedUsageResult = await recordAgentModelUsage(user, modelCfg, plannerMessages, plannedText, 'agent_planner', runId, {
                budget: taskBudget,
                usageRef: plannedTextUsageRef,
                allowBudgetExceeded: true
            });
            if (!plannedUsageResult?.budgetExceeded) assertRunWithinBudget();
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

            if (plannedUsageResult?.budgetExceeded) {
                const answer = plan.answer || await synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId, {
                    signal: runController.signal,
                    budget: taskBudget,
                    allowBudgetExceeded: true,
                    ...plannerChatContext
                });
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
            const operationSignature = `${plan.tool}:${approvalInputHash(effectivePlanInput)}`;
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
                        policyDecision: toolErr.code === 'AGENT_POLICY_DENIED' ? 'denied' : 'allow',
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
                if (step < maxSteps) await updateRun(runId, { status: 'replanning', updated_at: getBeijingTimestamp() });
            }
        }

        assertRunNotCancelled(runId);
        assertRunWithinBudget();
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
            answer = await withTimeout(signal => synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId, {
                signal,
                budget: taskBudget,
                allowBudgetExceeded: true,
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
                            allowBudgetExceeded: true,
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
        if (e.code === 'AGENT_BUDGET_EXCEEDED' || e.code === 'AGENT_TIMEOUT') {
            const reason = e.code === 'AGENT_TIMEOUT'
                ? '任务已达到运行时间上限，以下为已完成的部分结果。'
                : '任务已达到预算上限，以下为已完成的部分结果。';
            let answer = '';
            if (modelCfgForSummary && runForSummary) {
                try {
                    answer = await withTimeout(
                        () => synthesizeFinalAnswer(modelCfgForSummary, runForSummary.goal, observations, user, runId, {
                            budget: taskBudget,
                            allowBudgetExceeded: true,
                            chatAgent: runForSummary ? getRunMetadata(runForSummary).chatBridge : null
                        }),
                        30000,
                        'partial final summary'
                    );
                } catch (summaryError) {
                    logger.warn({ runId, err: summaryError.message }, '资源受限后的部分结果总结失败');
                }
            }
            if (!String(answer || '').trim()) {
                answer = observations.length
                    ? `已完成 ${observations.length} 项执行观察，但未能生成完整总结。`
                    : '任务在产生可用总结前被中止。';
            }
            const currentStatus = await getRunStatus(runId);
            if (!TERMINAL_STATUSES.has(currentStatus)) {
                await updateRun(runId, {
                    status: 'completed_with_errors',
                    final_answer: `${reason}\n\n${answer}`,
                    error_message: e.message || reason,
                    completed_at: getBeijingTimestamp(),
                    last_heartbeat_at: getBeijingTimestamp(),
                    updated_at: getBeijingTimestamp()
                });
                await createAgentNotification(user.id, runId, 'warning', '任务已生成部分结果', reason);
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

    return { runAgent };
}

module.exports = { createAgentRunner };
