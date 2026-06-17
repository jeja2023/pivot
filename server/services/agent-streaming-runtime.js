const { getBeijingTimestamp } = require('../time');
const { callModelStreamingWithTools, recordAgentModelUsage } = require('./agent-model');
const { buildAgentToolSchemas } = require('./agent-tool-catalog');
const { normalizeMaxSteps, normalizePositiveInt } = require('./agent-validators');
const { buildAssistantToolMessage, buildToolResultMessage } = require('./streaming-tools');
const { clampText, executeToolByName, findAgentToolByName } = require('./agent-tool-runtime');

// v0.0.49 开始支持 Agent 运行中的流式工具调用。
function isStreamingToolsEnabled() {
    return String(process.env.AGENT_STREAMING_TOOLS || '').toLowerCase() === 'true';
}

// 流式模式会把 Agent 工具转换成 OpenAI tools 格式，供 tool_calls 直接调用。
// 如果流式调用没有完成整次运行，返回 { completed: false }，交给 JSON 规划器兜底。
async function tryRunAgentStreaming({ run, user, modelCfg, toolList, runId, deadline, assertRunWithinBudget, assertRunNotCancelled, observations }, deps) {
    try {
        const tools = buildAgentToolSchemas(toolList);
        const systemPrompt = `你是 Pivot Agent。目标：${run.goal || ''}

需要时使用 tool_calls 调用工具；否则提供最终答案。返回结构化的工具输入 JSON。

【重要语言规则】你的思考、推理和所有输出必须使用中文。禁止使用英文提纲或英文推理过程。`;

        const conversation = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: run.goal || '' }
        ];
        let lastStep = deps.listSteps(runId).length;
        const maxSteps = normalizeMaxSteps(run.max_steps);
        for (let step = lastStep + 1; step <= lastStep + maxSteps; step += 1) {
            assertRunWithinBudget();
            assertRunNotCancelled(runId);
            deps.updateRun(runId, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
            const stepStart = Date.now();
            // 限制流式更新频率：除非内容增长明显，否则最多每 100ms 推送一次。
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
                deps.publishUserEvent(user.id, 'agent.streaming', {
                    runId,
                    step,
                    content: snapshot.content || '',
                    partialToolCalls: snapshot.partialToolCalls || [],
                    finishReason: snapshot.finishReason || null
                });
            };
            const result = await deps.withTimeout(
                callModelStreamingWithTools(modelCfg, conversation, tools, { temperature: 0.2, onDelta: emitDelta, user }),
                Math.min(180000, Math.max(deadline - Date.now(), 1000)),
                '流式工具规划'
            );
            // 推送最后一次流式快照，便于界面标记当前步骤已完成。
            deps.publishUserEvent(user.id, 'agent.streaming', {
                runId,
                step,
                content: result?.content || '',
                partialToolCalls: (result?.toolCalls || []).map(c => ({ id: c.id, name: c.name, argumentsRaw: c.argumentsRaw })),
                finishReason: result?.finishReason || null,
                completed: true
            });
            recordAgentModelUsage(user, modelCfg, conversation, result?.content || '', 'agent_planner_streaming', runId);
            deps.insertStep(runId, step, {
                type: 'plan',
                title: result?.hasToolCalls ? `流式工具计划：${result.toolCalls.map(c => c.name).filter(Boolean).join(', ') || '工具'}` : '流式最终答案',
                input: { goal: run.goal },
                output: {
                    content: result?.content || '',
                    toolCalls: (result?.toolCalls || []).map(c => ({ id: c.id, name: c.name, arguments: c.arguments || c.argumentsRaw })),
                    finishReason: result?.finishReason || ''
                },
                durationMs: Date.now() - stepStart
            });

            if (!result?.hasToolCalls) {
                const answer = result?.content || await deps.synthesizeFinalAnswer(modelCfg, run.goal, observations, user, runId);
                deps.updateRun(runId, {
                    status: 'completed',
                    final_answer: answer,
                    completed_at: getBeijingTimestamp(),
                    last_heartbeat_at: getBeijingTimestamp(),
                    updated_at: getBeijingTimestamp()
                });
                deps.createAgentNotification(user.id, runId, 'completed', 'Agent 运行已完成', deps.getAgentRunTitle(run));
                return { completed: true };
            }

            // 先保存助手发起工具调用的消息，再追加工具结果。
            conversation.push(buildAssistantToolMessage(result));

            // 逐个执行模型请求的工具调用，并把结果追加回对话。
            for (const call of result.toolCalls) {
                assertRunWithinBudget();
                assertRunNotCancelled(runId);
                const selectedTool = findAgentToolByName(call.name, toolList);
                if (!selectedTool) {
                    const message = `工具不可用或无权访问：${call.name || '-'}`;
                    conversation.push(buildToolResultMessage(call.id, { error: message }));
                    deps.insertStep(runId, deps.listSteps(runId).length + 1, {
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
                if (deps.maybePauseForApproval(run, selectedTool, call.arguments || {})) {
                    // 保持运行处于待审批状态；审批通过后由恢复流程继续。
                    return { completed: true };
                }
                const callStart = Date.now();
                try {
                    const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
                    const output = await deps.withTimeout(
                        executeToolByName(call.name, args, user, toolList, { run, modelCfg }),
                        Math.min(normalizePositiveInt(run.tool_timeout_ms, deps.agentToolTimeoutMs, 30000, 10 * 60 * 1000), Math.max(deadline - Date.now(), 1000)),
                        `执行工具：${call.name}`
                    );
                    const compactOutput = clampText(output, 10000);
                    observations.push({ step, tool: call.name, input: args, output: compactOutput });
                    deps.insertStep(runId, deps.listSteps(runId).length + 1, {
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
                    deps.insertStep(runId, deps.listSteps(runId).length + 1, {
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
        // 流式模式没有产出最终答案时，回退到 JSON 规划器。
        return { completed: false };
    } catch (streamErr) {
        // 流式调用异常时记录控制步骤，并继续使用 JSON 规划。
        deps.logger.warn({ runId, err: streamErr.message }, '流式工具调用失败，已回退到 JSON 规划器');
        deps.insertStep(runId, deps.listSteps(runId).length + 1, {
            type: 'control',
            title: '流式工具调用兜底',
            output: { error: streamErr.message }
        });
        return { completed: false };
    }
}

module.exports = {
    isStreamingToolsEnabled,
    tryRunAgentStreaming
};
