'use strict';

const crypto = require('crypto');
const { callModelJson, recordAgentModelUsage } = require('./agent-model');
const { classifyChatAutoExecution } = require('./chat-auto-execution');
const { readTypedEnv } = require('../config/env-registry');
const { createChatIntentAudit } = require('./chat-intent-audit');
const { getChatIntentConfig, chatIntentApplies } = require('./chat-route-config');
const { buildDecisionActionCandidate } = require('./decision-action-catalog');
const { resolveBusinessDecision } = require('./decision-runtime');
const { isDirectConversation } = require('./chat-capability-decision');
const { ACTIONS, normalizeIntent } = require('./chat-intent-contract');
const { buildChatIntentMessages } = require('./chat-intent-prompt');
const { resolveChatRequestScope, constrainChatDecision } = require('./chat-request-scope');
const { buildIntentFallback, buildUnappliedIntent } = require('./chat-intent-fallback');

const { createChatIntentBudget } = require('./chat-intent-budget');
const { buildChatIntentContext } = require('./chat-intent-context');
const { callChatIntentModel, isChatIntentTimeout } = require('./chat-intent-model');
const { decodeChatIntentPayload } = require('./chat-intent-schema');
const { explicitContinuationTarget, reconcileIntentAction, isStandaloneTextDraft } = require('./chat-intent-consistency');
const { resolveIntentRoutingModel } = require('./chat-intent-routing-model');
const { ensureModelQuota } = require('./model-daily-quota');

const INTENT_POLICY_VERSION = 'chat-intent-v8';

async function resolveChatIntent(input, deps = {}) {
    const { prompt, history = [], tasks = [], modelCfg, user, sessionId, userMessageId, preferences = [], providedSources = [], signal, availability = {}, executionAllowed = true } = input;
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('意图判断已取消');
    const baseline = classifyChatAutoExecution({ prompt, history });
    const requestScope = resolveChatRequestScope(prompt, { ...input, ...(input.requestScope || {}) });
    if (requestScope.directSourceAnswer) return constrainChatDecision({ ...baseline, action: 'direct_answer', nextAction: 'direct_answer',
        delegated: false, continuation: false, continuationOf: null, requiredCapabilities: [], modelCalls: 0, reasonCode: 'provided_source_analysis',
        routing: { source: 'semantic_intent', knowledge: 'none', tools: 'none', retrievalQuery: prompt, requestedCapabilities: [], toolNames: [], allowAutomaticRead: false } }, requestScope);
    const config = getChatIntentConfig(deps.config);
    if (['control', 'memory'].includes(baseline.action) || isDirectConversation(prompt, { history, tasks, providedSources })) return baseline;
    if (isStandaloneTextDraft(prompt, { history, tasks, providedSources })) return { ...normalizeIntent({ action: 'direct_answer', objective: prompt,
        requiredCapabilities: [], constraints: ['缺少的名称、日期与未提供的业务数值使用占位符，不编造事实。'], routing: { knowledge: 'none', tools: 'none' } },
    { baseline, tasks, history, userMessageId, prompt, requestScope, availability, requireRouting: true }), modelCalls: 0, durationMs: 0, policyVersion: INTENT_POLICY_VERSION,
    reasonCode: 'standalone_text_draft', shadow: false };
    const applied = !input.observeOnly && chatIntentApplies(config, user.id, sessionId);
    const explicitTarget = executionAllowed && applied ? explicitContinuationTarget(prompt, tasks) : null;
    if (explicitTarget) return { ...normalizeIntent({ action: 'continue_run', objective: Object.keys(explicitTarget.continuationUpdate).length
        ? `继续原任务：${explicitTarget.goal || ''}。本轮更新以当前要求为准：${prompt}` : explicitTarget.goal || prompt, continuationOf: explicitTarget.id,
        businessScope: explicitTarget.continuationUpdate, requiredCapabilities: [], constraints: Object.keys(explicitTarget.continuationUpdate).length ? [prompt] : [],
        routing: { knowledge: explicitTarget.requiredCapabilities?.some(cap => cap.startsWith('knowledge.')) ? 'required' : 'none', tools: 'task' } },
    { baseline, tasks, history, userMessageId, prompt, requestScope, availability, requireRouting: true }), modelCalls: 0, durationMs: 0, policyVersion: INTENT_POLICY_VERSION, reasonCode: 'explicit_task_continuation', shadow: false };
    let resolved = baseline;
    let failure = '';
    const started = Date.now();
    const budget = createChatIntentBudget({ signal, timeoutMs: config.timeoutMs, deadlineAt: input.deadlineAt });
    const audit = input.intentAudit || createChatIntentAudit({ user, sessionId, enqueueObservation: deps.recordDecision });
    const stats = { modelCalls: 0, structuredOutput: 'none' };
    let routingModel = modelCfg;
    let routingModelSource = 'current';
    const timingSnapshot = () => {
        if (stats.failureDiagnostic && !stats.activeUsageRef) return stats.failureDiagnostic;
        const active = stats.activeUsageRef || {};
        const snapshot = budget.snapshot();
        const queueMs = active.queueStartedAt && active.inFlight !== false ? (active.queueMs || 0) + (active.providerStartedAt || Date.now()) - active.queueStartedAt : active.queueMs ?? null;
        const providerMs = active.providerStartedAt && active.inFlight !== false ? (active.providerMs || 0) + Date.now() - active.providerStartedAt : active.providerMs ?? null;
        const stage = snapshot.stage || (stats.activeUsageRef ? 'model' : '');
        return { failureStage: stage === 'model' ? active.admittingQuota ? 'quota' : active.recordingUsage ? 'usage' : active.providerStartedAt ? 'model_provider' : active.queueStartedAt ? 'model_queue' : 'model' : stage,
            timing: { modelMs: snapshot.timings.model || 0, queueMs: queueMs === null && stats.queueMs === undefined ? null : (stats.queueMs || 0) + (queueMs || 0),
                providerMs: providerMs === null && stats.providerMs === undefined ? null : (stats.providerMs || 0) + (providerMs || 0), usageMs: stats.usageMs || 0, learningMs: snapshot.timings.learning || 0 },
            intentModelId: routingModel?.id || null, routingModelSource };
    };
    if (input.intentDiagnostics) input.intentDiagnostics.snapshot = timingSnapshot;
    try {
        if (config.mode !== 'disabled') void audit.resolveTenant().catch(() => {});
        if (config.mode !== 'disabled') {
            try {
                const context = buildChatIntentContext({ prompt, history, tasks, preferences, providedSources, availability });
                if (!context.requestContext.constraintsComplete) throw Object.assign(new Error('长请求的限制信息尚不完整'), { code: 'CHAT_INTENT_CONTEXT_INCOMPLETE' });
                const messages = buildChatIntentMessages({ preparedContext: context });
                const modelSelection = await resolveIntentRoutingModel(modelCfg, user, messages,
                    config.modelId ?? readTypedEnv('PIVOT_CHAT_INTENT_MODEL_ID'), budget, deps);
                routingModel = modelSelection.model;
                routingModelSource = modelSelection.source;
                for (let attempt = 0; ; attempt++) {
                    const usageRef = {};
                    stats.activeUsageRef = usageRef;
                    try {
                        const attemptMessages = attempt ? [{ ...messages[0], content: messages[0].content + '\n上次响应未通过格式校验。请重新判断同一用户请求，严格返回完整的decision JSON，使用正确字段类型与动作分支；不要输出推理或扩大工具、来源及权限。' }, ...messages.slice(1)] : messages;
                        const invoke = async (model, modelMessages, options) => {
                            usageRef.admittingQuota = true;
                            const quotaMessages = options.responseFormat ? [...modelMessages, { role: 'system', content: JSON.stringify(options.responseFormat) }] : modelMessages;
                            const releaseQuota = await (deps.ensureModelQuota || ensureModelQuota)(user, model, quotaMessages, options.maxTokens, { signal: options.signal });
                            usageRef.admittingQuota = false;
                            try {
                                const output = await (deps.callModelJson || callModelJson)(model, modelMessages, { ...options, quotaManaged: true });
                                if (!deps.callModelJson || deps.recordAgentModelUsage) {
                                    usageRef.recordingUsage = true;
                                    const usageStarted = Date.now();
                                    try { await (deps.recordAgentModelUsage || recordAgentModelUsage)(user, model, modelMessages, output, 'chat_intent', '', { usageRef, deferCalibration: true }); }
                                    finally { stats.usageMs = (stats.usageMs || 0) + Date.now() - usageStarted; usageRef.recordingUsage = false; }
                                }
                                return output;
                            } finally { releaseQuota(); }
                        };
                        const content = await budget.run('model', modelSignal => callChatIntentModel(invoke, routingModel, attemptMessages, { user, maxTokens: 2000, temperature: 0, enableThinking: false, usageRef, timeoutMs: budget.remainingMs(), deadlineAt: budget.deadlineAt, signal: modelSignal, source: 'chat_intent' }, stats));
                        if (signal?.aborted) throw signal.reason || new Error('意图判断已取消');
                        stats.outputTokens = (stats.outputTokens || 0) + (Number(usageRef.usage?.completion_tokens ?? usageRef.usage?.output_tokens) || 0) || null;
                        stats.inputTokens = (stats.inputTokens || 0) + (Number(usageRef.usage?.prompt_tokens ?? usageRef.usage?.input_tokens) || 0) || null;
                        if (usageRef.truncated) throw Object.assign(new Error('意图响应不完整'), { code: 'CHAT_INTENT_INVALID_CONTRACT' });
                        const parsed = decodeChatIntentPayload(typeof content === 'object' ? content : JSON.parse(String(content).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')));
                        const { raw, adjustments } = reconcileIntentAction(parsed, prompt, { tasks, history });
                        resolved = normalizeIntent(raw, { baseline, tasks: tasks.filter(task => context.tasks.some(item => item.id === task.id)), history, userMessageId, availability: context.availability, prompt, requestScope, requireRouting: true });
                        stats.providerAction = parsed?.action || '';
                        stats.contractAdjustments = adjustments;
                        break;
                    } catch (error) {
                        // 补判仍使用原始授权和相同校验，不把无效响应当作可执行决定。
                        if (attempt || !(error instanceof SyntaxError || error.code === 'CHAT_INTENT_INVALID_CONTRACT') || budget.signal.aborted || budget.remainingMs() < 2000) {
                            stats.failureDiagnostic = timingSnapshot();
                            stats.failureStage = stats.failureDiagnostic.failureStage;
                            throw error;
                        }
                        stats.contractRetries = 1;
                    } finally {
                        if (Number.isFinite(usageRef.queueMs)) stats.queueMs = (stats.queueMs || 0) + usageRef.queueMs;
                        if (Number.isFinite(usageRef.providerMs)) stats.providerMs = (stats.providerMs || 0) + usageRef.providerMs;
                        stats.activeUsageRef = null;
                    }
                }
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
                failure = isChatIntentTimeout(error) ? 'intent_timeout' : error.code === 'CHAT_INTENT_CONTEXT_INCOMPLETE' ? 'intent_context_incomplete' : error.code === 'CHAT_INTENT_INVALID_CONTRACT' || error instanceof SyntaxError ? 'intent_invalid_contract' : 'intent_provider_unavailable';
                stats.failureStage ||= budget.snapshot().stage;
                resolved = buildIntentFallback(baseline, failure);
            }
        }
        resolved = constrainChatDecision(resolved, requestScope);
        let selected = applied ? resolved : buildUnappliedIntent(baseline, config.mode);
        if (!executionAllowed && ['agent_run', 'continue_run'].includes(selected.action)) selected = { ...selected, action: 'direct_answer', nextAction: 'direct_answer', delegated: false, continuation: false, continuationOf: null, conversationTaskId: null,
            constraints: [...(selected.constraints || []), '当前任务自动执行未开放，本轮只提供说明，不执行操作。'],
            routing: { ...selected.routing, tools: 'none', allowAutomaticRead: false }, reasonCode: 'execution_not_enabled' };
        const tenantId = config.mode !== 'disabled' && !budget.signal.aborted ? await budget.run('tenant', () => audit.resolveTenant(), { optional: true, fallback: null, timeoutMs: Math.min(100, budget.remainingMs() / 6) }) : null;
        let learningDecisionId = null;
        let learningApplied = false;
        if (applied && !failure && executionAllowed && (!deps.recordDecision || deps.resolveBusinessDecision)) {
            // 已发布的路由经验只能在语义允许的集合内调整处理方式，不能凭偏好创建
            // 一个语义判断未授权的运行；模型型决策提供器不参与此处的二次推理。
            const candidates = ACTIONS.map(action => buildDecisionActionCandidate('chat.execution', action, { allowed: action === resolved.action || (resolved.delegated && ['direct_answer', 'plan_only'].includes(action)) }));
            const learned = await budget.run('learning', learningSignal => (deps.resolveBusinessDecision || resolveBusinessDecision)({ scenario: 'chat.execution', user, userId: user.id, tenantId, sessionId,
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
        if (budget.signal.aborted) {
            failure = 'intent_timeout';
            if (applied) selected = buildIntentFallback(baseline, failure);
        }
        const decisionId = audit.id;
        audit.record({ selected, suggested: resolved, applied: applied && !failure, mode: config.mode === 'disabled' ? 'disabled' : applied ? 'active' : 'shadow',
            failure, failureStage: stats.failureStage, durationMs: Date.now() - started, timing: timingSnapshot().timing, routingModelId: routingModel?.id,
            policyVersion: INTENT_POLICY_VERSION, taskState: { hash: crypto.createHash('sha256').update(prompt).digest('hex'), constraints: resolved.constraints, toolIntent: { requestedCapabilities: resolved.requiredCapabilities } },
            candidates: ACTIONS.map(action => buildDecisionActionCandidate('chat.execution', action)) });
        return { ...constrainChatDecision(selected, requestScope), decisionId: learningApplied && !failure ? learningDecisionId : decisionId, intentDecisionId: decisionId, learningDecisionId, learningApplied: learningApplied && !failure, modelCalls: stats.modelCalls, structuredOutput: stats.structuredOutput, contractFailureReason: stats.contractFailureReason || '', durationMs: Date.now() - started,
            providerAction: stats.providerAction || '', contractAdjustments: stats.contractAdjustments || [], providerRetries: stats.providerRetries || 0, contractRetries: stats.contractRetries || 0,
            usage: { inputTokens: stats.inputTokens ?? null, outputTokens: stats.outputTokens ?? null },
            timing: timingSnapshot().timing, failureStage: stats.failureStage || '', intentModelId: routingModel?.id || null, routingModelSource,
            modelId: modelCfg?.id || null, policyVersion: INTENT_POLICY_VERSION, shadow: !applied };
    } finally { budget.dispose(); }
}

module.exports = { resolveChatIntent, normalizeIntent };
