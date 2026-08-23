const { getBeijingTimestamp } = require('../time');
const { callModelStreamingWithTools, recordAgentModelUsage } = require('./agent-model');
const { buildAgentToolSchemas } = require('./agent-tool-catalog');
const { normalizeMaxSteps, normalizePositiveInt } = require('./agent-validators');
const { buildAssistantToolMessage, buildToolResultMessage } = require('./streaming-tools');
const { compactToolOutputForModel, executeToolByName, findAgentToolByName } = require('./agent-tool-runtime');
const { normalizeToolInput } = require('./agent-policy');
const { recordAgentToolCall } = require('./agent-tool-audit');
const { buildWorldStatePrompt } = require('./agent-step-context');
const { executeToolCallsInOrder } = require('./agent-tool-scheduler');

const MAX_STREAM_DELTA_EVENTS = Math.min(Math.max(Number(process.env.AGENT_EVENT_MAX_DELTAS || 512) || 512, 32), 2048);

// v0.0.49 开始支持 Agent 运行中的流式工具调用。
function isStreamingToolsEnabled() {
    return String(process.env.AGENT_STREAMING_TOOLS || '').toLowerCase() === 'true';
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
        const currentContent = Array.isArray(chatAgent?.currentMessage?.content)
            ? [{ type: 'text', text: run.goal || '' }, ...chatAgent.currentMessage.content]
            : run.goal || '';
        const conversation = [
            { role: 'system', content: effectiveSystemPrompt },
            ...history,
            ...contextMessages,
            { role: 'user', content: currentContent }
        ];
        let lastStep = (await deps.listSteps(runId)).length;
        let previousWorldState = null;
        const maxSteps = normalizeMaxSteps(run.max_steps, run.run_mode);
        for (let step = lastStep + 1; step <= lastStep + maxSteps; step += 1) {
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
                payload: {
                    contextHash: stepContext?.contextHash || '',
                    worldStateHash: stepContext?.worldStateHash || '',
                    worldStateMode: stepContext?.worldStateInjection?.mode || 'full',
                    previousWorldStateHash: stepContext?.previousWorldStateHash || '',
                    contextWindow: stepContext?.worldStateWindow || {}
                },
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
            // 限制流式更新频率：除非内容增长明显，否则最多每 100ms 推送一次。
            let lastEmittedAt = 0;
            let lastEmittedLen = 0;
            let persistedContentLength = 0;
            let lastDeltaSignature = '';
            let deltaIndex = 0;
            let deltaOverflow = false;
            let deltaEvents = Promise.resolve();
            const recordDelta = (snapshot, { completed = false } = {}) => {
                const content = String(snapshot?.content || '');
                const partialToolCalls = Array.isArray(snapshot?.partialToolCalls) ? snapshot.partialToolCalls : [];
                const signature = JSON.stringify({ content, partialToolCalls, finishReason: snapshot?.finishReason || '' });
                if (!completed && signature === lastDeltaSignature) return;
                lastDeltaSignature = signature;
                const contentDelta = content.slice(persistedContentLength);
                persistedContentLength = content.length;
                if (!completed && deltaIndex >= MAX_STREAM_DELTA_EVENTS) {
                    deltaOverflow = true;
                    return;
                }
                deltaIndex += 1;
                const eventDeltaIndex = deltaIndex;
                const eventDeltaOverflow = deltaOverflow;
                const eventKey = `model:${stepContext?.contextHash || step}:delta:${eventDeltaIndex}`;
                deltaEvents = deltaEvents.then(async () => {
                    try {
                        await deps.recordAgentEvent?.({
                            runId,
                            userId: user.id,
                            turnId: stepContext?.turnId || `${runId}:turn:${step}`,
                            stepIndex: step,
                            type: 'model.delta',
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
                const now = Date.now();
                const contentLen = (snapshot.content || '').length;
                const sizeDelta = Math.abs(contentLen - lastEmittedLen);
                if (now - lastEmittedAt < 100 && sizeDelta < 120) return;
                lastEmittedAt = now;
                lastEmittedLen = contentLen;
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
            const providerEvents = [];
            try {
                try {
                    await deps.recordAgentEvent?.({
                        runId,
                        userId: user.id,
                        turnId: stepContext?.turnId || `${runId}:turn:${step}`,
                        stepIndex: step,
                        type: 'model.requested',
                        payload: { purpose: 'agent_planner_streaming', messageCount: conversation.length, toolCount: tools.length, contextHash: stepContext?.contextHash || '' },
                        eventKey: `model:${stepContext?.contextHash || step}:requested`
                    });
                } catch (_) {}
                result = await deps.withTimeout(
                    signal => callStreamingModel(modelCfg, conversation, tools, {
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
                            purpose: 'agent_planner_streaming',
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
                        payload: { purpose: 'agent_planner_streaming', errorCode: modelError.code || '', errorMessage: modelError.message, contextHash: stepContext?.contextHash || '' },
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
                await recordUsage(user, modelCfg, conversation, result?.content || '', 'agent_planner_streaming', runId, {
                    budget: deps.taskBudget,
                    usage: result?.usage || result?.provider?.usage?.raw || null
                });
            roundsUsed += 1;
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
                const answer = result?.content || await deps.synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId, { budget: deps.taskBudget });
                await deps.updateRun(runId, {
                    status: 'completed',
                    final_answer: answer,
                    completed_at: getBeijingTimestamp(),
                    last_heartbeat_at: getBeijingTimestamp(),
                    updated_at: getBeijingTimestamp()
                });
                await deps.createAgentNotification(user.id, runId, 'completed', '任务运行已完成', deps.getAgentRunTitle(run));
                return { completed: true, roundsUsed };
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
                if (prepared.unavailable) return { ...prepared, status: 'unavailable', durationMs: 0 };
                const { call, input: args } = prepared;
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
                if (executed.status === 'unavailable') {
                    const message = executed.unavailable;
                    await deps.insertStep(runId, (await deps.listSteps(runId)).length + 1, {
                        type: 'tool',
                        title: `工具不可用：${call.name || '-'}`,
                        toolName: call.name || '',
                        input: args,
                        output: { error: message },
                        errorMessage: message,
                        status: 'error',
                        durationMs: 0,
                        contextHash: stepContext?.contextHash || ''
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
                        contextHash: stepContext?.contextHash || ''
                    });
                    conversation.push(buildToolResultMessage(call.id, { error: message }));
                    continue;
                }
                if (executed.status === 'success') {
                    const compactOutput = compactToolOutput(executed.output, modelCfg);
                    observations.push({ step, tool: call.name, input: args, output: compactOutput });
                    await deps.insertStep(runId, (await deps.listSteps(runId)).length + 1, {
                        type: 'tool', title: `工具执行完成：${call.name}`, toolName: call.name,
                        input: args, output: compactOutput, durationMs: executed.durationMs,
                        contextHash: stepContext?.contextHash || ''
                    });
                    await recordToolCall({
                        runId, stepId: `${runId}:${step}:${call.id || call.name}`,
                        operationKey: `${runId}:${step}:${call.id || call.name}`, toolName: call.name,
                        input: args, output: compactOutput, policyDecision: 'allow', status: 'success',
                        durationMs: executed.durationMs, contextHash: stepContext?.contextHash || ''
                    });
                    conversation.push(buildToolResultMessage(call.id, compactOutput));
                    await deps.finishAgentTraceSpan?.(executed.toolSpanId, {
                        output: compactOutput, durationMs: executed.durationMs, contextHash: stepContext?.contextHash || ''
                    });
                    continue;
                }
                const toolErr = executed.error || new Error('工具执行失败');
                observations.push({ step, tool: call.name, input: args, error: toolErr.message });
                await deps.insertStep(runId, (await deps.listSteps(runId)).length + 1, {
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
                });
                conversation.push(buildToolResultMessage(call.id, { error: toolErr.message }));
                await deps.finishAgentTraceSpan?.(executed.toolSpanId, {
                    status: 'error', errorMessage: toolErr.message,
                    durationMs: executed.durationMs, contextHash: stepContext?.contextHash || ''
                });
            }
        }
        // 流式模式没有产出最终答案时，回退到 JSON 规划器。
        return { completed: false, roundsUsed };
    } catch (streamErr) {
        if (['AGENT_APPROVAL_REQUIRED', 'AGENT_RUN_CANCELLED', 'AGENT_TIMEOUT'].includes(streamErr.code)) throw streamErr;
        // 流式调用异常时记录控制步骤，并继续使用 JSON 规划。
        deps.logger.warn({ runId, err: streamErr.message }, '流式工具调用失败，已回退到 JSON 规划器');
        await deps.insertStep(runId, (await deps.listSteps(runId)).length + 1, {
            type: 'control',
            title: '流式工具调用兜底',
            output: { error: streamErr.message }
        });
        return { completed: false, roundsUsed };
    }
}

module.exports = {
    isStreamingToolsEnabled,
    tryRunAgentStreaming
};
