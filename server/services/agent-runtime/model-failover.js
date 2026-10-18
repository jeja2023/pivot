'use strict';

const { recordPlannerModelEvent: recordPlannerModelEventDefault } = require('./planning-lifecycle');

/**
 * 将“是否允许在本轮自动换模型”的决策和实际 Run 执行拆开：该函数不发请求、
 * 不改状态，只在自动路由、可恢复供应方失败且存在兼容候选时返回一次切换计划。
 */
async function resolveAutomaticModelFailover({
    routerStrategy,
    error,
    user,
    currentModel,
    messages,
    endpointStatusGetter,
    isRecoverableModelProviderFailure = () => false,
    modelProviderFailureReason = item => String(item?.code || 'provider_failure'),
    pickFailoverModel = async () => null
} = {}) {
    if (routerStrategy === 'fixed' || !isRecoverableModelProviderFailure(error)) return null;
    const model = await pickFailoverModel({ user, currentModel, messages, endpointStatusGetter });
    return model ? { model, reason: modelProviderFailureReason(error) } : null;
}

async function executeAutomaticModelFailover(options = {}) {
    const failover = await resolveAutomaticModelFailover(options);
    if (!failover) return null;
    const {
        runId,
        step,
        turnId,
        contextHash,
        stepContext,
        user,
        plannerMessages = [],
        currentModel,
        signal,
        getTimestamp,
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
        minMaxTokens,
        recordPlannerModelEvent = recordPlannerModelEventDefault
    } = options;
    const fallback = failover.model;
    await updateRun(runId, { chosen_model_id: fallback.id, updated_at: getTimestamp() });
    await insertStep(runId, (await listSteps(runId)).length + 1, {
        type: 'control', title: '模型故障降级',
        output: {
            fromModelId: currentModel.id, toModelId: fallback.id, toModelName: fallback.name || fallback.model_name || '',
            reason: failover.reason, strategy: options.routerStrategy
        }
    });
    await recordAgentTraceSpan(runId, {
        type: 'routing', name: '模型故障降级',
        input: { fromModelId: currentModel.id, strategy: options.routerStrategy },
        output: { toModelId: fallback.id, reason: failover.reason },
        details: { preservedConstraints: ['tool_policy', 'approval_policy', 'budget', 'network_policy'] }
    });
    const startedAt = Date.now();
    const spanId = await startAgentTraceSpan(runId, {
        type: 'model', name: `规划模型故障降级 #${step}`,
        input: { messageCount: plannerMessages.length, model: fallback.name || fallback.model_name || fallback.id },
        details: { purpose: 'agent_planner_failover', step, failedModelId: currentModel.id }, contextHash
    });
    try {
        const usageRef = {};
        const timeoutMs = remainingModelRequestMs();
        const plannedText = await withTimeout(abortSignal => callModelText(fallback, plannerMessages, {
            user, signal: abortSignal, usageRef, minMaxTokens,
            enableThinking: resolveAgentPlanningThinking(fallback), timeoutMs
        }), timeoutMs, '智能体规划降级', { signal });
        await recordAgentEvent({
            runId, userId: user.id, turnId, stepIndex: step, type: 'model.completed',
            payload: { ...buildAgentAuditFields(stepContext || { contextHash }, { entrypoint: 'agent', purpose: 'agent_planner_failover_completed' }), responseLength: String(plannedText || '').length, failedModelId: currentModel.id, modelId: fallback.id },
            eventKey: `model:${contextHash}:failover_completed`
        });
        await recordPlannerModelEvent('failover', {
            runId, user, turnId, step, stepContext, model: fallback,
            purpose: 'agent_planner_failover_completed', responseLength: String(plannedText || '').length,
            reason: failover.reason, failedModelId: currentModel.id
        });
        await finishAgentTraceSpan(spanId, {
            output: { responseLength: String(plannedText || '').length, failedModelId: currentModel.id },
            durationMs: Date.now() - startedAt, contextHash
        });
        return { ...failover, plannedText, usageRef };
    } catch (fallbackError) {
        await finishAgentTraceSpan(spanId, {
            status: 'error', errorMessage: fallbackError.message, durationMs: Date.now() - startedAt, contextHash
        });
        throw fallbackError;
    }
}

module.exports = { executeAutomaticModelFailover, resolveAutomaticModelFailover };
