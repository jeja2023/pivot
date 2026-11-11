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
const { resolveChatRequestScope, constrainChatDecision } = require('./chat-request-scope');
const { buildIntentFallback } = require('./chat-intent-fallback');

const { createChatIntentBudget } = require('./chat-intent-budget');
const { buildChatIntentContext } = require('./chat-intent-context');
const { callChatIntentModel } = require('./chat-intent-model');
const { decodeChatIntentPayload } = require('./chat-intent-schema');
const { explicitContinuationTarget, reconcileIntentAction, isStandaloneTextDraft } = require('./chat-intent-consistency');

const INTENT_POLICY_VERSION = 'chat-intent-v6';

async function resolveChatIntent(input, deps = {}) {
    const { prompt, history = [], tasks = [], modelCfg, user, sessionId, userMessageId, preferences = [], providedSources = [], signal, availability = {}, executionAllowed = true } = input;
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('意图判断已取消');
    const baseline = classifyChatAutoExecution({ prompt, history });
    const requestScope = resolveChatRequestScope(prompt, { ...input, ...(input.requestScope || {}) });
    if (requestScope.directSourceAnswer) return constrainChatDecision({ ...baseline, action: 'direct_answer', nextAction: 'direct_answer',
        delegated: false, continuation: false, continuationOf: null, requiredCapabilities: [], modelCalls: 0, reasonCode: 'provided_source_analysis',
        routing: { source: 'semantic_intent', knowledge: 'none', tools: 'none', retrievalQuery: prompt, requestedCapabilities: [], toolNames: [], allowAutomaticRead: false } }, requestScope);
    const config = deps.config || {
        mode: readTypedEnv('PIVOT_CHAT_INTENT_MODE'), timeoutMs: readTypedEnv('PIVOT_CHAT_INTENT_TIMEOUT_MS'),
        rolloutPercent: readTypedEnv('PIVOT_CHAT_INTENT_ROLLOUT_PERCENT')
    };
    if (['control', 'memory'].includes(baseline.action) || isDirectConversation(prompt, { history, tasks, providedSources })) return baseline;
    if (isStandaloneTextDraft(prompt, { history, tasks, providedSources })) return { ...normalizeIntent({ action: 'direct_answer', objective: prompt,
        requiredCapabilities: [], constraints: ['缺少的名称、日期与未提供的业务数值使用占位符，不编造事实。'], routing: { knowledge: 'none', tools: 'none' } },
    { baseline, tasks, history, userMessageId, prompt, requestScope, availability, requireRouting: true }), modelCalls: 0, durationMs: 0, policyVersion: INTENT_POLICY_VERSION,
    reasonCode: 'standalone_text_draft', shadow: false };
    const bucket = crypto.createHash('sha256').update(`${user.id}:${sessionId}`).digest().readUInt32BE(0) % 100;
    const explicitTarget = executionAllowed && config.mode === 'active' && bucket < config.rolloutPercent ? explicitContinuationTarget(prompt, tasks) : null;
    if (explicitTarget) return { ...normalizeIntent({ action: 'continue_run', objective: Object.keys(explicitTarget.continuationUpdate).length
        ? `继续原任务：${explicitTarget.goal || ''}。本轮更新以当前要求为准：${prompt}` : explicitTarget.goal || prompt, continuationOf: explicitTarget.id,
        businessScope: explicitTarget.continuationUpdate, requiredCapabilities: [], constraints: Object.keys(explicitTarget.continuationUpdate).length ? [prompt] : [],
        routing: { knowledge: explicitTarget.requiredCapabilities?.some(cap => cap.startsWith('knowledge.')) ? 'required' : 'none', tools: 'task' } },
    { baseline, tasks, history, userMessageId, prompt, requestScope, availability, requireRouting: true }), modelCalls: 0, durationMs: 0, policyVersion: INTENT_POLICY_VERSION, reasonCode: 'explicit_task_continuation', shadow: false };
    let resolved = baseline;
    let failure = '';
    const started = Date.now();
    const budget = createChatIntentBudget({ signal, timeoutMs: config.timeoutMs, deadlineAt: input.deadlineAt });
    const stats = { modelCalls: 0, structuredOutput: 'none' };
    try {
        if (config.mode !== 'disabled') {
            try {
                const context = buildChatIntentContext({ prompt, history, tasks, preferences, providedSources, availability });
                if (!context.requestContext.constraintsComplete) throw Object.assign(new Error('长请求的限制信息尚不完整'), { code: 'CHAT_INTENT_CONTEXT_INCOMPLETE' });
                const messages = buildChatIntentMessages({ preparedContext: context });
                const usageRef = {};
                const content = await budget.run('model', modelSignal => callChatIntentModel(deps.callModelJson || callModelJson, modelCfg, messages, { user, maxTokens: 2000, temperature: 0, enableThinking: false, usageRef, timeoutMs: budget.remainingMs(), deadlineAt: budget.deadlineAt, signal: modelSignal, source: 'chat_intent' }, stats));
                stats.queueMs = Number(usageRef.queueMs) || 0;
                stats.providerMs = Number(usageRef.providerMs) || 0;
                if (signal?.aborted) throw signal.reason || new Error('意图判断已取消');
                if (!deps.callModelJson) await budget.run('usage', () => recordAgentModelUsage(user, modelCfg, messages, content, 'chat_intent', '', { usageRef }));
                if (usageRef.truncated) throw Object.assign(new Error('意图响应不完整'), { code: 'CHAT_INTENT_INVALID_CONTRACT' });
                const parsed = decodeChatIntentPayload(typeof content === 'object' ? content : JSON.parse(String(content).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')));
                const { raw, adjustments } = reconcileIntentAction(parsed, prompt, { tasks, history });
                stats.providerAction = parsed?.action || '';
                stats.contractAdjustments = adjustments;
                stats.outputTokens = Number(usageRef.usage?.completion_tokens ?? usageRef.usage?.output_tokens) || null;
                stats.inputTokens = Number(usageRef.usage?.prompt_tokens ?? usageRef.usage?.input_tokens) || null;
                resolved = normalizeIntent(raw, { baseline, tasks: tasks.filter(task => context.tasks.some(item => item.id === task.id)), history, userMessageId, availability: context.availability, prompt, requestScope, requireRouting: true });
                if (!context.requestContext.complete) {
                    if (!resolved.delegated && (resolved.routing.tools === 'read_only' || resolved.routing.knowledge !== 'none')) throw Object.assign(new Error('长请求需要完整资料复核后才能查询'), { code: 'CHAT_INTENT_CONTEXT_INCOMPLETE' });
                    if (resolved.delegated) {
                        resolved.requiredCapabilities = [...new Set([...resolved.requiredCapabilities, 'conversation.read_source'])];
                        resolved.routing.requestedCapabilities = [...new Set([...resolved.routing.requestedCapabilities, 'conversation.read_source'])];
                        resolved.acceptance.requireEvidence = true;
                    }
                }
                resolved.inputContext = { complete: context.requestContext.complete, constraintsComplete: context.requestContext.constraintsComplete, originalCharacters: context.requestContext.originalCharacters || String(prompt).length };
            } catch (error) {
                if (signal?.aborted) throw error;
                if (error.code === 'CHAT_INTENT_INVALID_CONTRACT') stats.contractFailureReason = error.message;
                failure = error.code === 'CHAT_INTENT_TIMEOUT' ? 'intent_timeout' : error.code === 'CHAT_INTENT_CONTEXT_INCOMPLETE' ? 'intent_context_incomplete' : error.code === 'CHAT_INTENT_INVALID_CONTRACT' || error instanceof SyntaxError ? 'intent_invalid_contract' : 'intent_provider_unavailable';
                resolved = buildIntentFallback(baseline, failure);
            }
        }
        resolved = constrainChatDecision(resolved, requestScope);
        const applied = config.mode === 'active' && bucket < config.rolloutPercent;
        let selected = failure || applied ? resolved : { ...baseline, action: baseline.action === 'plan_only' ? 'plan_only' : 'direct_answer', reasonCode: 'intent_shadow' };
        if (!executionAllowed && ['agent_run', 'continue_run'].includes(selected.action)) selected = { ...selected, action: 'direct_answer', nextAction: 'direct_answer', delegated: false, continuation: false, continuationOf: null, conversationTaskId: null,
            constraints: [...(selected.constraints || []), '当前任务自动执行未开放，本轮只提供说明，不执行操作。'],
            routing: { ...selected.routing, tools: 'none', allowAutomaticRead: false }, reasonCode: 'execution_not_enabled' };
        let learningDecisionId = null;
        let learningApplied = false;
        if (applied && !failure && executionAllowed && (!deps.recordDecision || deps.resolveBusinessDecision)) {
            // 已发布的路由经验只能在语义允许的集合内调整处理方式，不能凭偏好创建
            // 一个语义判断未授权的运行；模型型决策提供器不参与此处的二次推理。
            const candidates = ACTIONS.map(action => buildDecisionActionCandidate('chat.execution', action, { allowed: action === resolved.action || (resolved.delegated && ['direct_answer', 'plan_only'].includes(action)) }));
            const learned = await budget.run('learning', learningSignal => (deps.resolveBusinessDecision || resolveBusinessDecision)({ scenario: 'chat.execution', user, userId: user.id, tenantId: user.tenant_id || null, sessionId,
                taskState: { hash: crypto.createHash('sha256').update(prompt).digest('hex'), constraints: resolved.constraints, toolIntent: { requestedCapabilities: resolved.requiredCapabilities } },
                candidates, fallbackActionId: resolved.action, actionScores: { [resolved.action]: 1 }, baselineVersion: INTENT_POLICY_VERSION, signal: learningSignal }), { optional: true, fallback: null, timeoutMs: Math.min(1000, budget.remainingMs()) }).catch(error => { if (signal?.aborted) throw error; return null; });
            learningDecisionId = learned?.decisionId || null;
            if (learned?.policy?.applied && learned.selectedActionId !== selected.action && candidates.some(candidate => candidate.id === learned.selectedActionId && candidate.allowed)) {
                selected = { ...selected, action: learned.selectedActionId, nextAction: learned.selectedActionId, delegated: false, continuation: false, continuationOf: null,
                    routing: { ...selected.routing, ...(learned.selectedActionId === 'plan_only' ? { knowledge: 'none', requireEvidence: false } : {}), tools: 'none', allowAutomaticRead: false } };
            }
            learningApplied = Boolean(learned?.decisionId) && learned?.policy?.applied === true && learned.selectedActionId === selected.action
                && candidates.some(candidate => candidate.id === selected.action && candidate.allowed);
        }
        if (signal?.aborted) throw signal.reason || new Error('意图判断已取消');
        if (budget.signal.aborted) { failure = 'intent_timeout'; selected = buildIntentFallback(baseline, failure); }
        const decisionId = `chat_intent_${crypto.randomUUID()}`;
        (deps.recordDecision || recordDecision)({
            decisionId, userId: user.id, tenantId: user.tenant_id || null, sessionId,
            context: { scenario: 'chat.execution', taskState: { hash: crypto.createHash('sha256').update(prompt).digest('hex'), constraints: resolved.constraints, toolIntent: { requestedCapabilities: resolved.requiredCapabilities } }, candidates: ACTIONS.map(action => buildDecisionActionCandidate('chat.execution', action)) },
            selectedActionId: selected.action,
            providerOutputs: [{ providerId: 'chat-intent', providerVersion: String(modelCfg?.id || ''), selectedActionId: resolved.action, durationMs: Date.now() - started, error: failure, scores: { [resolved.action]: resolved.confidence || 0 } }],
            policy: { mode: applied ? 'active' : 'shadow', policyVersion: INTENT_POLICY_VERSION, selectedActionId: selected.action, suggestedActionId: resolved.action, applied, reasonCode: resolved.reasonCode }
        });
        return { ...constrainChatDecision(selected, requestScope), decisionId: learningApplied && !failure ? learningDecisionId : decisionId, intentDecisionId: decisionId, learningDecisionId, learningApplied: learningApplied && !failure, modelCalls: stats.modelCalls, structuredOutput: stats.structuredOutput, contractFailureReason: stats.contractFailureReason || '', durationMs: Date.now() - started,
            providerAction: stats.providerAction || '', contractAdjustments: stats.contractAdjustments || [], providerRetries: stats.providerRetries || 0,
            usage: { inputTokens: stats.inputTokens ?? null, outputTokens: stats.outputTokens ?? null },
            timing: { modelMs: budget.timings.model || 0, queueMs: stats.queueMs ?? null, providerMs: stats.providerMs ?? null, usageMs: budget.timings.usage || 0, learningMs: budget.timings.learning || 0 }, modelId: modelCfg?.id || null, policyVersion: INTENT_POLICY_VERSION, shadow: !applied };
    } finally { budget.dispose(); }
}

module.exports = { resolveChatIntent, normalizeIntent };
