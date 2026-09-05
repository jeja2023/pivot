const { getBeijingTimestamp } = require('../time');
const { callModelStreamingWithTools, recordAgentModelUsage } = require('./agent-model');
const { buildAgentToolSchemas } = require('./agent-tool-catalog');
const { normalizeMaxSteps, normalizePositiveInt } = require('./agent-validators');
const { buildAssistantToolMessage, buildToolResultMessage } = require('./streaming-tools');
const { compactToolOutputForModel, executeToolByName, findAgentToolByName } = require('./agent-tool-runtime');
const { normalizeToolInput } = require('./agent-policy');
const { recordAgentToolCall } = require('./agent-tool-audit');
const { buildAgentAuditFields, buildWorldStatePrompt } = require('./agent-step-context');
const { executeToolCallsInOrder } = require('./agent-tool-scheduler');
const { fitMessagesToContextBudget } = require('./context-budget');
const {
    classifyNativeToolCallError,
    recordNativeToolCallCapability,
    shouldUseNativeToolCalls
} = require('./model-tool-call-capabilities');

const MAX_STREAM_AUDIT_SNAPSHOTS = Math.min(
    Math.max(Number.parseInt(process.env.AGENT_EVENT_MAX_SNAPSHOTS || '64', 10) || 64, 8),
    256
);
const STREAM_UI_SAMPLE_INTERVAL_MS = 100;
const STREAM_AUDIT_SAMPLE_INTERVAL_MS = 400;
const STREAM_AUDIT_MIN_GROWTH = 800;

function createStreamingSnapshotSampler({
    maxAuditSnapshots = MAX_STREAM_AUDIT_SNAPSHOTS,
    uiIntervalMs = STREAM_UI_SAMPLE_INTERVAL_MS,
    auditIntervalMs = STREAM_AUDIT_SAMPLE_INTERVAL_MS,
    auditMinGrowth = STREAM_AUDIT_MIN_GROWTH
} = {}) {
    let lastUiAt = null;
    let lastUiLength = 0;
    let lastAuditAt = null;
    let lastAuditLength = 0;
    let lastAuditSignature = '';
    let auditCount = 0;
    let auditOverflow = false;

    const signatureOf = snapshot => JSON.stringify({
        content: String(snapshot?.content || ''),
        partialToolCalls: Array.isArray(snapshot?.partialToolCalls) ? snapshot.partialToolCalls : [],
        finishReason: snapshot?.finishReason || ''
    });

    function sampleUi(snapshot, now = Date.now()) {
        if (!snapshot) return false;
        const contentLength = String(snapshot.content || '').length;
        const changedEnough = Math.abs(contentLength - lastUiLength) >= 120;
        if (lastUiAt !== null && now - lastUiAt < uiIntervalMs && !changedEnough) return false;
        lastUiAt = now;
        lastUiLength = contentLength;
        return true;
    }

    function sampleAudit(snapshot, { completed = false, now = Date.now() } = {}) {
        if (!snapshot) return null;
        const signature = signatureOf(snapshot);
        if (!completed && signature === lastAuditSignature) return null;
        const contentLength = String(snapshot.content || '').length;
        const toolCount = Array.isArray(snapshot.partialToolCalls) ? snapshot.partialToolCalls.length : 0;
        const changedEnough = Math.abs(contentLength - lastAuditLength) >= auditMinGrowth;
        const toolChanged = signature !== lastAuditSignature && toolCount > 0;
        const timeReached = lastAuditAt === null || now - lastAuditAt >= auditIntervalMs;
        const isKeySnapshot = completed || auditCount === 0 || changedEnough || toolChanged || Boolean(snapshot.finishReason) || timeReached;
        if (!isKeySnapshot) return null;
        // Reserve the final slot so every step has a durable terminal snapshot.
        if (!completed && auditCount >= Math.max(Number(maxAuditSnapshots) - 1, 1)) {
            auditOverflow = true;
            return null;
        }
        if (completed && auditCount >= Number(maxAuditSnapshots)) {
            auditOverflow = true;
            return { replaceLast: true, overflow: true };
        }
        lastAuditSignature = signature;
        lastAuditAt = now;
        lastAuditLength = contentLength;
        auditCount += 1;
        return { replaceLast: false, overflow: auditOverflow, index: auditCount };
    }

    return {
        sampleUi,
        sampleAudit,
        getAuditCount: () => auditCount,
        didOverflow: () => auditOverflow
    };
}

// v0.0.49 开始支持 Agent 运行中的流式工具调用。
function isStreamingToolsEnabled(modelCfg = {}, env = process.env) {
    const legacySwitch = String(env.AGENT_STREAMING_TOOLS || '').trim().toLowerCase();
    if (['0', 'false', 'disabled', 'off'].includes(legacySwitch)) return false;
    return shouldUseNativeToolCalls(modelCfg, env);
}

// 流式模式会把 Agent 工具转换成 OpenAI tools 格式，供 tool_calls 直接调用。
// 如果流式调用没有完成整次运行，返回 { completed: false }，交给 JSON 规划器兜底。
async function tryRunAgentStreaming({ run, user, modelCfg, toolList, runId, deadline, assertRunWithinBudget, assertRunNotCancelled, observations, chatContext = {} }, deps) {
    let roundsUsed = 0;
    try {
        const callStreamingModel = deps.callModelStreamingWithTools || callModelStreamingWithTools;
        const executeTool = deps.executeToolByName || executeToolByName;
        const compactToolOutput = deps.compactToolOutputForModel || compactToolOutputForModel;
        const recordToolCall = deps.recordAgentToolCall || recordAgentToolCall;
        const recordUsage = deps.recordAgentModelUsage || recordAgentModelUsage;
        const recordToolCallCapability = deps.recordNativeToolCallCapability || recordNativeToolCallCapability;
        const taskBudget = deps.taskBudget || null;
        const tools = buildAgentToolSchemas(toolList);
        const systemPrompt = `你是 Pivot Agent。目标：${run.goal || ''}

需要时使用 tool_calls 调用工具；否则提供最终答案。返回结构化的工具输入 JSON。

【重要语言规则】你的思考、推理和所有输出必须使用中文。禁止使用英文提纲或英文推理过程。`;

        const history = Array.isArray(chatContext.chatHistory)
            ? chatContext.chatHistory
                .filter(message => ['user', 'assistant'].includes(String(message?.role || '').toLowerCase()))
                .map(message => ({ role: String(message.role).toLowerCase(), content: message.content }))
            : [];
        const chatAgent = chatContext.chatAgent && typeof chatContext.chatAgent === 'object' ? chatContext.chatAgent : null;
        const effectiveSystemPrompt = chatAgent?.systemPrompt
            ? `${systemPrompt}\n\n当前会话系统提示词：${String(chatAgent.systemPrompt).slice(0, 12000)}`
            : systemPrompt;
        const contextMessages = [
            chatAgent?.memoryContext ? { role: 'user', content: chatAgent.memoryContext } : null,
            chatAgent?.ragContext ? { role: 'user', content: chatAgent.ragContext } : null
        ].filter(Boolean);
        const currentMessageParts = Array.isArray(chatAgent?.currentMessage?.content)
            ? chatAgent.currentMessage.content.filter(part => part && typeof part === 'object')
            : [];
        const currentMediaParts = currentMessageParts.filter(part => part.type === 'image_url' || part.type === 'input_image');
        const currentContent = currentMessageParts.length
            ? [
                { type: 'text', text: run.goal || '' },
                ...(currentMediaParts.length ? currentMediaParts : currentMessageParts)
            ]
            : run.goal || '';
        const conversation = [
            { role: 'system', content: effectiveSystemPrompt },
            ...history,
            ...contextMessages,
            { role: 'user', content: currentContent }
        ];
        // step_index also belongs to tool/control records; use the explicit
        // resume cursor instead of counting persisted rows as planning rounds.
        const lastStep = Math.max(Number(run.resume_from_step || 0) || 0, 0);
        let previousWorldState = null;
        const maxSteps = normalizeMaxSteps(run.max_steps, run.run_mode);
        roundsUsed = lastStep;
        let lastOperationSignature = '';
        let stagnantRounds = 0;
        let capabilityRecorded = false;
        const completeWithWarning = async (reason) => {
            let answer = '';
            try {
                answer = await deps.synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId, {
                    budget: taskBudget,
                    allowBudgetExceeded: true
                });
            } catch (_) {
                answer = observations.length ? '已完成部分执行，但未能生成完整总结。' : '任务在生成完整结果前被中止。';
            }
            await deps.updateRun(runId, {
                status: 'completed_with_errors',
                final_answer: `注意：${reason}\n\n${answer}`,
                error_message: reason,
                completed_at: getBeijingTimestamp(),
                last_heartbeat_at: getBeijingTimestamp(),
                updated_at: getBeijingTimestamp()
            });
            await deps.createAgentNotification(user.id, runId, 'warning', '任务已生成部分结果', reason);
            return { completed: true, roundsUsed, partial: true };
        };
        for (let step = lastStep + 1; step <= maxSteps; step += 1) {
            if (taskBudget) taskBudget.consumeStep();
            assertRunWithinBudget();
            await assertRunNotCancelled(runId);
            const controlMessages = await deps.pollAgentControlMessages?.(runId, user, { limit: 20 });
            if (Array.isArray(controlMessages)) {
                controlMessages.forEach(message => conversation.push({
                    role: 'user',
                    content: `PIVOT_AGENT_CONTROL_BEGIN\n${JSON.stringify({
                        messageId: message.message_id,
                        messageType: message.message_type,
                        fromRunId: message.from_run_id || '',
                        payload: message.payload || {}
                    })}\nPIVOT_AGENT_CONTROL_END`
                }));
            }
            const stepContext = await deps.captureStepContext?.({
                run,
                user,
                turnId: `${runId}:turn:${step}`,
                stepIndex: step,
                modelCfg,
                toolList,
                previousWorldState,
                contextConfig: run.context_config || {},
                policy: { toolPolicy: run.tool_policy, toolAllowlist: run.tool_allowlist, approvalPolicy: run.approval_policy, networkPolicy: run.network_policy },
                deadline,
                signal: deps.signal
            });
            previousWorldState = stepContext?.worldState || previousWorldState;
            await deps.recordAgentEvent?.({
                runId,
                userId: user.id,
                turnId: stepContext?.turnId || `${runId}:turn:${step}`,
                stepIndex: step,
                type: 'step.context_captured',
                payload: buildAgentAuditFields(stepContext || {}, { entrypoint: 'agent', purpose: 'agent_streaming_context_captured' }),
                eventKey: stepContext?.contextHash || ''
            });
            conversation[0] = {
                role: 'system',
                content: `${effectiveSystemPrompt}\n\n${buildWorldStatePrompt(stepContext?.worldState || {}, { injection: stepContext?.worldStateInjection })}`
            };
            await deps.updateRun(runId, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
            const stepStart = Date.now();
            const modelSpanId = await deps.startAgentTraceSpan?.(runId, {
                type: 'model',
                name: `流式规划模型调用 #${step}`,
                input: { messageCount: conversation.length, toolCount: tools.length, model: modelCfg.name || modelCfg.model_name || modelCfg.id },
                details: { purpose: 'agent_planner_streaming', step },
                contextHash: stepContext?.contextHash || ''
            });
            let persistedContentLength = 0;
            const snapshotSampler = createStreamingSnapshotSampler();
            let deltaEvents = Promise.resolve();
            const recordDelta = (snapshot, { completed = false } = {}) => {
                const content = String(snapshot?.content || '');
                const partialToolCalls = Array.isArray(snapshot?.partialToolCalls) ? snapshot.partialToolCalls : [];
                const sampled = snapshotSampler.sampleAudit(snapshot, { completed });
                if (!sampled) return;
                const contentDelta = content.slice(persistedContentLength);
                persistedContentLength = content.length;
                const eventDeltaIndex = sampled.index || snapshotSampler.getAuditCount();
                const eventDeltaOverflow = sampled.overflow;
                const eventKey = `model:${stepContext?.contextHash || step}:delta:${eventDeltaIndex}`;
                deltaEvents = deltaEvents.then(async () => {
                    try {
                        await deps.recordAgentEvent?.({
                            runId,
                            userId: user.id,
                            turnId: stepContext?.turnId || `${runId}:turn:${step}`,
                            stepIndex: step,
                            type: 'model.delta',
                            stepContext,
                            entrypoint: 'agent',
                            payload: {
                                purpose: 'agent_planner_streaming',
                                deltaIndex: eventDeltaIndex,
                                contentDelta,
                                partialToolCalls,
                                finishReason: snapshot?.finishReason || null,
                                completed,
                                deltaOverflow: eventDeltaOverflow,
                                contextHash: stepContext?.contextHash || ''
                            },
                            eventKey
                        });
                    } catch (_) {
                        // Event persistence is an audit side channel; a transient failure must not abort the model stream.
                    }
                });
            };
            const emitDelta = (snapshot) => {
                if (!snapshot) return;
                if (!snapshotSampler.sampleUi(snapshot)) return;
                recordDelta(snapshot);
                deps.publishUserEvent(user.id, 'agent.streaming', {
                    runId,
                    step,
                    content: snapshot.content || '',
                    partialToolCalls: snapshot.partialToolCalls || [],
                    finishReason: snapshot.finishReason || null
                });
            };
            let result;
            let usageResult = null;
            let conversationForModel = fitMessagesToContextBudget(conversation, modelCfg);
            if (conversationForModel.metadata?.unbounded) {
                const fallbackContextWindow = Math.max(Number.parseInt(process.env.AGENT_CONTEXT_WINDOW_TOKENS || process.env.AGENT_STREAM_CONTEXT_WINDOW_TOKENS || '32768', 10) || 32768, 8192);
                conversationForModel = fitMessagesToContextBudget(conversation, modelCfg, { contextWindowTokens: fallbackContextWindow });
            }
            conversationForModel = conversationForModel.messages;
            const providerEvents = [];
            try {
                try {
                    await deps.recordAgentEvent?.({
                        runId,
                        userId: user.id,
                        turnId: stepContext?.turnId || `${runId}:turn:${step}`,
                        stepIndex: step,
                        type: 'model.requested',
                        payload: { ...buildAgentAuditFields(stepContext || {}, { entrypoint: 'agent', purpose: 'agent_streaming_requested' }), messageCount: conversationForModel.length, toolCount: tools.length },
                        eventKey: `model:${stepContext?.contextHash || step}:requested`
                    });
                } catch (_) {}
                result = await deps.withTimeout(
                    signal => callStreamingModel(modelCfg, conversationForModel, tools, {
                        temperature: 0.2,
                        onDelta: emitDelta,
                        onProviderEvent: event => {
                            if (providerEvents.length < 256) providerEvents.push(event);
                        },
                        user,
                        signal
                    }),
                    Math.min(180000, Math.max(deadline - Date.now(), 1000)),
                    '流式工具规划',
                    { signal: deps.signal || null }
                );
                if (!capabilityRecorded) {
                    capabilityRecorded = true;
                    try {
                        await recordToolCallCapability(modelCfg, {
                            status: 'supported',
                            protocol: result?.provider?.protocol || 'chat_completions'
                        });
                    } catch (_) {
                        // Capability telemetry must never invalidate a successful task.
                    }
                }
                try {
                    for (const providerEvent of providerEvents) {
                        await deps.recordAgentEvent?.({
                            runId,
                            userId: user.id,
                            turnId: stepContext?.turnId || `${runId}:turn:${step}`,
                            stepIndex: step,
                            type: 'model.provider_event',
                            payload: providerEvent,
                            eventKey: `model:${stepContext?.contextHash || step}:provider:${providerEvent.sequence}`
                        });
                    }
                    await deps.recordAgentEvent?.({
                        runId,
                        userId: user.id,
                        turnId: stepContext?.turnId || `${runId}:turn:${step}`,
                        stepIndex: step,
                        type: 'model.completed',
                        payload: {
                            ...buildAgentAuditFields(stepContext || {}, { entrypoint: 'agent', purpose: 'agent_streaming_completed' }),
                            responseLength: String(result?.content || '').length,
                            toolCallCount: result?.toolCalls?.length || 0,
                            contextHash: stepContext?.contextHash || '',
                            provider: result?.provider ? {
                                status: result.provider.status,
                                protocol: result.provider.protocol,
                                responseId: result.provider.responseId,
                                eventCount: result.provider.eventCount,
                                finishReason: result.provider.finishReason,
                                usage: result.provider.usage
                            } : null
                        },
                        eventKey: `model:${stepContext?.contextHash || step}:completed`
                    });
                } catch (_) {}
                await deps.finishAgentTraceSpan?.(modelSpanId, {
                    output: { responseLength: String(result?.content || '').length, toolCallCount: result?.toolCalls?.length || 0, finishReason: result?.finishReason || '' },
                    durationMs: Date.now() - stepStart,
                    contextHash: stepContext?.contextHash || ''
                });
            } catch (modelError) {
                try {
                    await deps.recordAgentEvent?.({
                        runId,
                        userId: user.id,
                        turnId: stepContext?.turnId || `${runId}:turn:${step}`,
                        stepIndex: step,
                        type: 'model.failed',
                        payload: { ...buildAgentAuditFields(stepContext || {}, { entrypoint: 'agent', purpose: 'agent_streaming_failed' }), errorCode: modelError.code || '', errorMessage: modelError.message },
                        eventKey: `model:${stepContext?.contextHash || step}:failed`
                    });
                } catch (_) {}
                await deps.finishAgentTraceSpan?.(modelSpanId, {
                    status: 'error',
                    errorMessage: modelError.message,
                    durationMs: Date.now() - stepStart,
                    contextHash: stepContext?.contextHash || ''
                });
                throw modelError;
            }
            // 推送最后一次流式快照，便于界面标记当前步骤已完成。
            recordDelta({
                content: result?.content || '',
                partialToolCalls: (result?.toolCalls || []).map(c => ({ id: c.id, name: c.name, argumentsRaw: c.argumentsRaw })),
                finishReason: result?.finishReason || null
            }, { completed: true });
            await deltaEvents;
            deps.publishUserEvent(user.id, 'agent.streaming', {
                runId,
                step,
                content: result?.content || '',
                partialToolCalls: (result?.toolCalls || []).map(c => ({ id: c.id, name: c.name, argumentsRaw: c.argumentsRaw })),
                finishReason: result?.finishReason || null,
                completed: true
            });
                usageResult = await recordUsage(user, modelCfg, conversationForModel, result?.content || '', 'agent_planner_streaming', runId, {
                    budget: deps.taskBudget,
                    usage: result?.usage || result?.provider?.usage?.raw || null,
                    allowBudgetExceeded: true
                });
            roundsUsed = step;
            await deps.insertStep(runId, step, {
                type: 'plan',
                title: result?.hasToolCalls ? `流式工具计划：${result.toolCalls.map(c => c.name).filter(Boolean).join(', ') || '工具'}` : '流式最终答案',
                input: { goal: run.goal },
                output: {
                    content: result?.content || '',
                    toolCalls: (result?.toolCalls || []).map(c => ({ id: c.id, name: c.name, arguments: c.arguments || c.argumentsRaw })),
                    finishReason: result?.finishReason || ''
                },
                durationMs: Date.now() - stepStart,
                contextHash: stepContext?.contextHash || ''
            });

            if (!result?.hasToolCalls) {
                const answer = result?.content || await deps.synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId, {
                    budget: deps.taskBudget,
                    allowBudgetExceeded: true
                });
                const budgetWarning = usageResult?.budgetExceeded ? '已达到总 Token 预算，以下为当前已生成结果。' : '';
                await deps.updateRun(runId, {
                    status: budgetWarning ? 'completed_with_errors' : 'completed',
                    final_answer: budgetWarning ? `注意：${budgetWarning}\n\n${answer}` : answer,
                    error_message: budgetWarning,
                    completed_at: getBeijingTimestamp(),
                    last_heartbeat_at: getBeijingTimestamp(),
                    updated_at: getBeijingTimestamp()
                });
                await deps.createAgentNotification(user.id, runId, budgetWarning ? 'warning' : 'completed', budgetWarning ? '任务已生成部分结果' : '任务运行已完成', deps.getAgentRunTitle(run));
                return { completed: true, roundsUsed };
            }

            // The model response is already paid for. Do not execute another
            // tool after the response itself crossed the token ceiling.
            if (usageResult?.budgetExceeded) {
                const answer = await deps.synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId, {
                    budget: deps.taskBudget,
                    allowBudgetExceeded: true
                });
                await deps.updateRun(runId, {
                    status: 'completed_with_errors',
                    final_answer: `注意：已达到总 Token 预算，任务已停止继续调用工具。\n\n${answer}`,
                    error_message: '已达到总 Token 预算，任务已停止继续调用工具。',
                    completed_at: getBeijingTimestamp(),
                    last_heartbeat_at: getBeijingTimestamp(),
                    updated_at: getBeijingTimestamp()
                });
                await deps.createAgentNotification(user.id, runId, 'warning', '任务已生成部分结果', '已达到总 Token 预算，任务已停止继续调用工具。');
                return { completed: true, roundsUsed, partial: true };
            }

            // 先保存助手发起工具调用的消息，再追加工具结果。
            conversation.push(buildAssistantToolMessage(result));

            // First validate/approve every call in model order. Only then can adjacent
            // read-only calls run together without letting a side effect race ahead.
            const preparedCalls = [];
            for (const call of result.toolCalls) {
                assertRunWithinBudget();
                await assertRunNotCancelled(runId);
                const selectedTool = findAgentToolByName(call.name, toolList);
                if (!selectedTool) {
                    const message = `工具不可用或无权访问：${call.name || '-'}`;
                    preparedCalls.push({ call, tool: null, input: call.arguments || {}, unavailable: message });
                    continue;
                }
                const args = normalizeToolInput(call.name, call.arguments || {}, {
                    ...run,
                    model_id: run.model_id ?? modelCfg?.id,
                    chosen_model_id: run.chosen_model_id ?? modelCfg?.id
                });
                if (await deps.maybePauseForApproval(run, selectedTool, args)) {
                    // 保持运行处于待审批状态；审批通过后由恢复流程继续。
                    return { completed: true, roundsUsed };
                }
                preparedCalls.push({ call, tool: selectedTool, input: args });
            }

            const executedCalls = await executeToolCallsInOrder(preparedCalls, async prepared => {
                if (prepared.unavailable) {
                    if (taskBudget) taskBudget.consumeTool({ name: prepared.call?.name || '' });
                    return { ...prepared, status: 'unavailable', durationMs: 0 };
                }
                const { call, input: args } = prepared;
                if (taskBudget) taskBudget.consumeTool(prepared.tool || { name: call?.name || '' });
                const callStart = Date.now();
                await assertRunNotCancelled(runId);
                assertRunWithinBudget();
                const toolSpanId = await deps.startAgentTraceSpan?.(runId, {
                    type: 'tool',
                    name: `工具调用：${call.name}`,
                    input: args,
                    details: { step, toolName: call.name, source: 'streaming_tool_call', concurrency: prepared.tool.concurrency || '' },
                    contextHash: stepContext?.contextHash || ''
                });
                try {
                    const output = await deps.withTimeout(
                        signal => executeTool(call.name, args, user, toolList, {
                            run,
                            modelCfg,
                            autonomous: true,
                            stepId: `${runId}:${step}:${call.id || call.name}`,
                            stepIndex: step,
                            stepContext,
                            contextHash: stepContext?.contextHash || '',
                            budget: deps.taskBudget || null,
                            budgetAlreadyConsumed: true,
                            approvalGranted: Boolean(deps.getRunMetadata?.(run)?.approvedTools?.includes(call.name)),
                            allowApproval: Boolean(deps.getRunMetadata?.(run)?.approvedTools?.includes(call.name)),
                            signal,
                            waitForWorkflowDelay: deps.waitForWorkflowDelay,
                            delayKey: call.name === 'workflow.delay' ? `${call.name}:stream:${step}:${call.id || 'call'}` : ''
                        }),
                        Math.min(normalizePositiveInt(run.tool_timeout_ms, deps.agentToolTimeoutMs, 30000, 10 * 60 * 1000), Math.max(deadline - Date.now(), 1000)),
                        `执行工具：${call.name}`,
                        { signal: deps.signal || null }
                    );
                    return { ...prepared, status: 'success', output, toolSpanId, durationMs: Date.now() - callStart };
                } catch (toolErr) {
                    if (['AGENT_APPROVAL_REQUIRED', 'AGENT_RUN_CANCELLED', 'AGENT_TIMEOUT'].includes(toolErr.code)) throw toolErr;
                    return { ...prepared, status: 'error', error: toolErr, toolSpanId, durationMs: Date.now() - callStart };
                }
            }, { signal: deps.signal, maxReadConcurrency: deps.streamingReadConcurrency });

            // Persist results and return them to the model in exactly the original tool-call order.
            for (const executed of executedCalls) {
                const { call, input: args } = executed;
                const operationSignature = `${call.name}:${JSON.stringify(args || {})}`;
                stagnantRounds = operationSignature === lastOperationSignature ? stagnantRounds + 1 : 1;
                lastOperationSignature = operationSignature;
                if (executed.status === 'unavailable') {
                    const message = executed.unavailable;
                    await deps.insertStep(runId, step, {
                        type: 'tool',
                        title: `工具不可用：${call.name || '-'}`,
                        toolName: call.name || '',
                        input: args,
                        output: { error: message },
                        errorMessage: message,
                        status: 'error',
                        durationMs: 0,
                        contextHash: stepContext?.contextHash || '',
                        stepContext,
                        entrypoint: 'agent'
                    });
                    await recordToolCall({
                        runId,
                        stepId: `${runId}:${step}:${call.id || call.name}`,
                        operationKey: `${runId}:${step}:${call.id || call.name}`,
                        toolName: call.name,
                        input: args,
                        output: { error: message },
                        policyDecision: 'allow',
                        status: 'error',
                        errorCategory: 'permission',
                        errorMessage: message,
                        durationMs: 0,
                        contextHash: stepContext?.contextHash || '',
                        stepContext,
                        entrypoint: 'agent'
                    });
                    if (taskBudget) taskBudget.recordError();
                    conversation.push(buildToolResultMessage(call.id, { error: message }));
                    continue;
                }
                if (executed.status === 'success') {
                    const compactOutput = compactToolOutput(executed.output, modelCfg);
                    observations.push({ step, tool: call.name, input: args, output: compactOutput });
                    await deps.insertStep(runId, step, {
                        type: 'tool', title: `工具执行完成：${call.name}`, toolName: call.name,
                        input: args, output: compactOutput, durationMs: executed.durationMs,
                        contextHash: stepContext?.contextHash || ''
                    });
                    await recordToolCall({
                        runId, stepId: `${runId}:${step}:${call.id || call.name}`,
                        operationKey: `${runId}:${step}:${call.id || call.name}`, toolName: call.name,
                        input: args, output: compactOutput, policyDecision: 'allow', status: 'success',
                        durationMs: executed.durationMs, contextHash: stepContext?.contextHash || ''
                        ,stepContext, entrypoint: 'agent'
                    });
                    conversation.push(buildToolResultMessage(call.id, compactOutput));
                    await deps.finishAgentTraceSpan?.(executed.toolSpanId, {
                        output: compactOutput, durationMs: executed.durationMs, contextHash: stepContext?.contextHash || ''
                    });
                    if (taskBudget) taskBudget.recordSuccess();
                    continue;
                }
                const toolErr = executed.error || new Error('工具执行失败');
                observations.push({ step, tool: call.name, input: args, error: toolErr.message });
                await deps.insertStep(runId, step, {
                    type: 'tool', title: `工具执行失败：${call.name}`, toolName: call.name,
                    input: args, output: { error: toolErr.message }, errorMessage: toolErr.message,
                    status: 'error', durationMs: executed.durationMs, contextHash: stepContext?.contextHash || ''
                });
                await recordToolCall({
                    runId, stepId: `${runId}:${step}:${call.id || call.name}`,
                    operationKey: `${runId}:${step}:${call.id || call.name}`, toolName: call.name,
                    input: args, output: { error: toolErr.message },
                    policyDecision: toolErr.code === 'AGENT_POLICY_DENIED' ? 'denied' : 'allow',
                    status: 'error', errorCategory: toolErr.category || 'unknown', errorMessage: toolErr.message,
                    durationMs: executed.durationMs, contextHash: stepContext?.contextHash || ''
                    ,stepContext, entrypoint: 'agent'
                });
                conversation.push(buildToolResultMessage(call.id, { error: toolErr.message }));
                await deps.finishAgentTraceSpan?.(executed.toolSpanId, {
                    status: 'error', errorMessage: toolErr.message,
                    durationMs: executed.durationMs, contextHash: stepContext?.contextHash || ''
                });
                if (taskBudget) taskBudget.recordError();
            }
            if (stagnantRounds >= 3) {
                return completeWithWarning(`检测到工具 ${lastOperationSignature.split(':')[0] || '调用'} 连续重复且没有进展，已提前停止。`);
            }
        }
        // 流式模式没有产出最终答案时，回退到 JSON 规划器。
        return { completed: false, roundsUsed };
    } catch (streamErr) {
        if (['AGENT_APPROVAL_REQUIRED', 'AGENT_RUN_CANCELLED', 'AGENT_TIMEOUT', 'AGENT_BUDGET_EXCEEDED'].includes(streamErr.code)) throw streamErr;
        const fallback = classifyNativeToolCallError(streamErr);
        try {
            await (deps.recordNativeToolCallCapability || recordNativeToolCallCapability)(modelCfg, fallback);
        } catch (_) {
            // Fallback remains safe when the capability record cannot be persisted.
        }
        try {
            await deps.recordAgentEvent?.({
                runId,
                userId: user?.id || null,
                type: 'model.native_tool_calls_fallback',
                payload: {
                    purpose: 'agent_native_tool_calls_fallback',
                    capabilityStatus: fallback.status,
                    httpStatus: fallback.httpStatus,
                    reason: fallback.reason
                },
                eventKey: `native-tool-calls:${modelCfg?.id || modelCfg?.model_name || 'unknown'}:${fallback.status}`
            });
        } catch (_) {}
        // 流式调用异常时记录控制步骤，并继续使用 JSON 规划。
        deps.logger.warn({ runId, err: streamErr.message, capabilityStatus: fallback.status }, '原生工具调用失败，已回退到 JSON 规划器');
        await deps.insertStep(runId, (await deps.listSteps(runId)).length + 1, {
            type: 'control',
            title: '流式工具调用兜底',
            output: { error: streamErr.message, fallbackReason: fallback.reason, capabilityStatus: fallback.status }
        });
        return { completed: false, roundsUsed };
    }
}

module.exports = {
    createStreamingSnapshotSampler,
    isStreamingToolsEnabled,
    tryRunAgentStreaming
};
