'use strict';

const crypto = require('crypto');
const { callModelJson, recordAgentModelUsage } = require('./agent-model');
const { classifyChatAutoExecution } = require('./chat-auto-execution');
const { readTypedEnv } = require('../config/env-registry');
const { recordDecision } = require('./decision-observability');
const { buildDecisionActionCandidate } = require('./decision-action-catalog');
const { resolveBusinessDecision } = require('./decision-runtime');
const { isDirectConversation } = require('./chat-capability-decision');
const { ACTIONS, normalizeIntent } = require('./chat-intent-contract');
const { buildChatIntentMessages } = require('./chat-intent-prompt');

const INTENT_POLICY_VERSION = 'chat-intent-v3';

async function callWithIntentDeadline(invoke, signal, timeoutMs) {
    const controller = new AbortController();
    let timer;
    let onAbort;
    try {
        return await new Promise((resolve, reject) => {
            onAbort = () => {
                const error = signal?.reason instanceof Error ? signal.reason : new Error('意图判断已取消');
                controller.abort(error);
                reject(error);
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) { onAbort(); return; }
            timer = setTimeout(() => {
                const error = Object.assign(new Error('意图判断超时'), { code: 'CHAT_INTENT_TIMEOUT' });
                controller.abort(error);
                reject(error);
            }, timeoutMs);
            Promise.resolve().then(() => invoke(controller.signal)).then(resolve, reject);
        });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

async function resolveChatIntent(input, deps = {}) {
    const { prompt, history = [], tasks = [], modelCfg, user, sessionId, userMessageId, preferences = [], providedSources = [], signal, availability = {}, executionAllowed = true } = input;
    const baseline = classifyChatAutoExecution({ prompt, history });
    const config = deps.config || {
        mode: readTypedEnv('PIVOT_CHAT_INTENT_MODE'), timeoutMs: readTypedEnv('PIVOT_CHAT_INTENT_TIMEOUT_MS'),
        rolloutPercent: readTypedEnv('PIVOT_CHAT_INTENT_ROLLOUT_PERCENT')
    };
    if (['control', 'memory'].includes(baseline.action) || isDirectConversation(prompt, { history, tasks, providedSources })) return baseline;
    let resolved = baseline;
    let failure = '';
    const started = Date.now();
    if (config.mode !== 'disabled') {
        try {
            const messages = buildChatIntentMessages({ prompt, history, tasks, preferences, providedSources, availability });
            const usageRef = {};
            const content = await callWithIntentDeadline(modelSignal => (deps.callModelJson || callModelJson)(modelCfg, messages, { user, maxTokens: 1600, temperature: 0, enableThinking: false, usageRef, timeoutMs: config.timeoutMs, signal: modelSignal, source: 'chat_intent' }), signal, config.timeoutMs);
            if (signal?.aborted) throw signal.reason || new Error('意图判断已取消');
            if (!deps.callModelJson) await recordAgentModelUsage(user, modelCfg, messages, content, 'chat_intent', '', { usageRef });
            if (usageRef.truncated) throw Object.assign(new Error('意图响应不完整'), { code: 'CHAT_INTENT_INVALID_CONTRACT' });
            const raw = typeof content === 'object' ? content : JSON.parse(String(content).trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
            resolved = normalizeIntent(raw, { baseline, tasks, history, userMessageId, availability });
        } catch (error) {
            if (signal?.aborted) throw error;
            failure = error.code === 'CHAT_INTENT_TIMEOUT' ? 'intent_timeout' : error.code === 'CHAT_INTENT_INVALID_CONTRACT' || error instanceof SyntaxError ? 'intent_invalid_contract' : 'intent_provider_unavailable';
            resolved = { ...baseline, action: baseline.action === 'direct_answer' ? 'direct_answer' : baseline.action === 'plan_only' ? 'plan_only' : 'clarify', question: '暂时无法可靠判断本次任务的处理范围，请稍后重试；你的请求已保留。', reasonCode: 'intent_unavailable', failureCode: failure, capabilityDecisionUnavailable: true };
        }
    }
    const bucket = crypto.createHash('sha256').update(`${user.id}:${sessionId}`).digest()[0] % 100;
    const applied = config.mode === 'active' && bucket < config.rolloutPercent;
    let selected = applied ? resolved : { ...baseline, action: baseline.action === 'plan_only' ? 'plan_only' : 'direct_answer', reasonCode: 'intent_shadow' };
    if (!executionAllowed && ['agent_run', 'continue_run'].includes(selected.action)) selected = { ...selected, action: 'direct_answer', nextAction: 'direct_answer', delegated: false, continuation: false, continuationOf: null, conversationTaskId: null,
        constraints: [...(selected.constraints || []), '当前任务自动执行未开放，本轮只提供说明，不执行操作。'],
        routing: { ...selected.routing, tools: 'none', allowAutomaticRead: false }, reasonCode: 'execution_not_enabled' };
    let learningDecisionId = null;
    if (applied && !failure && executionAllowed && (!deps.recordDecision || deps.resolveBusinessDecision)) {
        // 已发布的路由经验只能在语义允许的集合内调整处理方式，不能凭偏好创建
        // 一个语义判断未授权的运行；模型型决策提供器不参与此处的二次推理。
        const candidates = ACTIONS.map(action => buildDecisionActionCandidate('chat.execution', action, { allowed: action === resolved.action || (resolved.delegated && ['direct_answer', 'plan_only'].includes(action)) }));
        const learned = await (deps.resolveBusinessDecision || resolveBusinessDecision)({ scenario: 'chat.execution', user, userId: user.id, tenantId: user.tenant_id || null, sessionId,
            taskState: { hash: crypto.createHash('sha256').update(prompt).digest('hex'), constraints: resolved.constraints, toolIntent: { requestedCapabilities: resolved.requiredCapabilities } },
            candidates, fallbackActionId: resolved.action, actionScores: { [resolved.action]: 1 }, baselineVersion: INTENT_POLICY_VERSION, signal }).catch(() => null);
        learningDecisionId = learned?.decisionId || null;
        if (learned?.policy?.applied && learned.selectedActionId !== selected.action && candidates.some(candidate => candidate.id === learned.selectedActionId && candidate.allowed)) {
            selected = { ...selected, action: learned.selectedActionId, nextAction: learned.selectedActionId, delegated: false, continuation: false, continuationOf: null,
                routing: { ...selected.routing, ...(learned.selectedActionId === 'plan_only' ? { knowledge: 'none', requireEvidence: false } : {}), tools: 'none', allowAutomaticRead: false } };
        }
    }
    if (signal?.aborted) throw signal.reason || new Error('意图判断已取消');
    const decisionId = `chat_intent_${crypto.randomUUID()}`;
    (deps.recordDecision || recordDecision)({
        decisionId, userId: user.id, tenantId: user.tenant_id || null, sessionId,
        context: { scenario: 'chat.execution', taskState: { hash: crypto.createHash('sha256').update(prompt).digest('hex'), constraints: resolved.constraints, toolIntent: { requestedCapabilities: resolved.requiredCapabilities } }, candidates: ACTIONS.map(action => buildDecisionActionCandidate('chat.execution', action)) },
        selectedActionId: selected.action,
        providerOutputs: [{ providerId: 'chat-intent', providerVersion: String(modelCfg?.id || ''), selectedActionId: resolved.action, durationMs: Date.now() - started, error: failure, scores: { [resolved.action]: resolved.confidence || 0 } }],
        policy: { mode: applied ? 'active' : 'shadow', policyVersion: INTENT_POLICY_VERSION, selectedActionId: selected.action, suggestedActionId: resolved.action, applied, reasonCode: resolved.reasonCode }
    });
    return { ...selected, decisionId, learningDecisionId, modelCalls: config.mode === 'disabled' ? 0 : 1, durationMs: Date.now() - started, modelId: modelCfg?.id || null, policyVersion: INTENT_POLICY_VERSION, shadow: !applied };
}

module.exports = { resolveChatIntent, normalizeIntent };
