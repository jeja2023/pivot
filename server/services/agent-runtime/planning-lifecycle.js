'use strict';

const { recordAgentEvent } = require('../agent-event-log');
const { buildAgentAuditFields } = require('../agent-step-context');
const { dispatchPostLifecycleHook } = require('../agent-lifecycle-dispatcher');

const HOOK_EVENT_FOR_MODEL_EVENT = Object.freeze({
    requested: 'plan.requested',
    completed: 'plan.completed',
    failed: 'plan.failed',
    failover: 'plan.failover'
});

function planningPayload({ runId, step, model, purpose = '', messageCount = 0, responseLength = 0, error = null, reason = '', failedModelId = null } = {}) {
    return {
        run: { id: String(runId || '') },
        planning: {
            step: Math.max(0, Number(step || 0) || 0),
            modelId: model?.id ?? null,
            failedModelId: failedModelId ?? null,
            purpose: String(purpose || '').slice(0, 80),
            messageCount: Math.max(0, Number(messageCount || 0) || 0),
            responseLength: Math.max(0, Number(responseLength || 0) || 0),
            errorCode: String(error?.code || '').slice(0, 120),
            reason: String(reason || '').slice(0, 160)
        }
    };
}

async function dispatchPlannerLifecycleHook({ modelEvent, user, runId, step, model, purpose, messageCount, responseLength, error, reason, failedModelId, dispatch = dispatchPostLifecycleHook } = {}) {
    const eventType = HOOK_EVENT_FOR_MODEL_EVENT[String(modelEvent || '')];
    if (!eventType || !runId || !user?.id) return { dispatched: false, reason: 'invalid_planning_event' };
    return await dispatch({
        eventType,
        user,
        run: { id: String(runId), user_id: user.id },
        payload: planningPayload({ runId, step, model, purpose, messageCount, responseLength, error, reason, failedModelId }),
        eventKey: `lifecycle:${eventType}:${runId}:${Math.max(0, Number(step || 0) || 0)}:${model?.id || 'none'}`
    });
}

async function recordPlannerModelEvent(modelEvent, { runId, user, turnId, step, stepContext, model, purpose, messageCount, responseLength, error, reason, failedModelId, recordEvent = recordAgentEvent, buildAuditFields = buildAgentAuditFields, dispatch = dispatchPostLifecycleHook } = {}) {
    const eventType = `model.${String(modelEvent || '')}`;
    const payload = planningPayload({ runId, step, model, purpose, messageCount, responseLength, error, reason, failedModelId });
    try {
        await recordEvent({
            runId,
            userId: user?.id || null,
            turnId,
            stepIndex: step,
            type: eventType,
            payload: {
                ...buildAuditFields(stepContext || {}, { entrypoint: 'agent', purpose: String(purpose || `agent_planner_${modelEvent}`) }),
                ...payload.planning,
                errorMessage: error ? String(error.message || '').slice(0, 500) : ''
            },
            eventKey: `model:${stepContext?.contextHash || step || 0}:${modelEvent}`
        });
    } catch (_) {
        // 模型事件审计不能改变已经发生的模型请求或应答。
    }
    try {
        await dispatchPlannerLifecycleHook({ modelEvent, user, runId, step, model, purpose, messageCount, responseLength, error, reason, failedModelId, dispatch });
    } catch (_) {
        // 后置 Hook 的异常由其自身审计；规划结果不能被事后 Hook 回滚。
    }
}

module.exports = { recordPlannerModelEvent };
