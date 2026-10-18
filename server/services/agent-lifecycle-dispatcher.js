'use strict';

/*
 * Lifecycle Hook 的统一投递与审计边界。
 *
 * 后置事件发生在真实状态已落库之后，因此任何 Hook 异常只能写入审计，绝不能把
 * 已完成的提交/回滚伪装为失败。前置策略仍由 Tool Orchestrator 在副作用之前
 * fail-closed 地执行。
 */
const { invokeAgentLifecycleHooks } = require('./agent-lifecycle-hooks');
const { recordAgentEvent } = require('./agent-event-log');

function lifecycleHooksEnabled(context = {}) {
    return context.lifecycleHooksEnabled === true
        || String((context.env || process.env).PIVOT_AGENT_LIFECYCLE_HOOKS_ENABLED || '').toLowerCase() === 'true';
}

function auditDecisions(result = {}) {
    return (result.decisions || []).map(item => ({
        hookId: String(item.hookId || ''),
        decision: String(item.decision || ''),
        reason: String(item.reason || '').slice(0, 300)
    }));
}

function lifecycleHookPayload(payload = {}, context = {}) {
    const scopes = context.authorizedScopes || context.authorized_scopes || context.agentScopes || context.agent_scopes || [];
    const authorization = payload.authorization && typeof payload.authorization === 'object' && !Array.isArray(payload.authorization)
        ? payload.authorization : {};
    return { ...payload, authorization: { ...authorization, scopes } };
}

function blockingDecision(result = {}) {
    return (result?.decisions || []).find(item => String(item?.decision || '') === 'deny') || null;
}

async function dispatchPreLifecycleHook({
    eventType,
    user,
    run = {},
    payload = {},
    context = {},
    eventKey = '',
    invokeHooks = invokeAgentLifecycleHooks,
    recordEvent = recordAgentEvent
} = {}) {
    if (!lifecycleHooksEnabled(context)) return { dispatched: false, reason: 'disabled', denied: false, blocking: null };
    // 前置 Hook 在状态变更前运行。invokeAgentLifecycleHooks 会依据冻结事件的
    // failurePolicy 抛出 fail-closed 错误；这里绝不将错误降格为 observe。
    const result = await invokeHooks({ eventType, phase: 'pre', user, payload: lifecycleHookPayload(payload, context) });
    const blocking = blockingDecision(result);
    if (run?.id) {
        try {
            await recordEvent({
                runId: run.id,
                userId: run.user_id || user?.id || null,
                type: 'hook.preflight',
                eventKey: String(eventKey || `hook:${eventType}`).slice(0, 255),
                payload: {
                    hookEventType: eventType,
                    hookDecisions: auditDecisions(result),
                    hookContextCount: Array.isArray(result?.additionalContext) ? result.additionalContext.length : 0,
                    denied: Boolean(blocking)
                }
            });
        } catch (_) {
            // 生命周期 Hook 的审计表已由调用器写入；事件旁路不可放宽已作出的拒绝。
        }
    }
    return { dispatched: true, result, denied: Boolean(blocking), blocking };
}

async function dispatchPostLifecycleHook({
    eventType,
    user,
    run = {},
    payload = {},
    context = {},
    eventKey = '',
    invokeHooks = invokeAgentLifecycleHooks,
    recordEvent = recordAgentEvent
} = {}) {
    if (!lifecycleHooksEnabled(context)) return { dispatched: false, reason: 'disabled' };
    try {
        const result = await invokeHooks({ eventType, phase: 'post', user, payload: lifecycleHookPayload(payload, context) });
        if (run?.id) {
            await recordEvent({
                runId: run.id,
                userId: run.user_id || user?.id || null,
                type: 'hook.post',
                eventKey: String(eventKey || `hook:${eventType}`).slice(0, 255),
                payload: {
                    hookEventType: eventType,
                    hookDecisions: auditDecisions(result),
                    hookContextCount: Array.isArray(result?.additionalContext) ? result.additionalContext.length : 0
                }
            });
        }
        return { dispatched: true, result };
    } catch (error) {
        if (run?.id) {
            try {
                await recordEvent({
                    runId: run.id,
                    userId: run.user_id || user?.id || null,
                    type: 'hook.post_failed',
                    eventKey: String(eventKey || `hook:${eventType}`).slice(0, 255),
                    payload: {
                        hookEventType: eventType,
                        errorCode: String(error?.code || ''),
                        errorMessage: String(error?.message || '').slice(0, 500)
                    }
                });
            } catch (_) {
                // 审计存储本身不可用也不能回滚已经生效的后置状态。
            }
        }
        return { dispatched: false, error };
    }
}

module.exports = {

    dispatchPreLifecycleHook,
    dispatchPostLifecycleHook,
    lifecycleHookPayload,
    lifecycleHooksEnabled
};
