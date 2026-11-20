'use strict';

const { estimateTokens } = require('../llm');
const { classifyChatAutoExecution } = require('./chat-auto-execution');
const { resolveChatIntent } = require('./chat-intent-resolver');
const { getConversationTasks, continueConversationTask } = require('./chat-task-continuation');
const { handleChatMemoryRequest } = require('./chat-memory-actions');
const { retrieveLongTermMemories } = require('./long-term-memory');
const { recordDecisionOutcome } = require('./decision-observability');
const ledger = require('../repositories/chat-conversation-turns');
const { detectChatRouteCorrection, recordChatRouteCorrection, applyAutomaticExecutionDecision } = require('./chat-route-correction');
const { isDirectConversation } = require('./chat-capability-decision');
const { getChatCapabilityAvailability } = require('./chat-capability-scope');
const { resolveChatRequestScope, constrainChatDecision, toolAllowedByRequestScope } = require('./chat-request-scope');
const { applyChatRouteCorrection } = require('./chat-route-correction-handler');
const { buildIntentFallback, buildUnappliedIntent } = require('./chat-intent-fallback');
const { getChatIntentConfig, chatIntentApplies } = require('./chat-route-config');
const { createChatIntentAudit } = require('./chat-intent-audit');
const { createChatIntentBudget } = require('./chat-intent-budget');
const { ACTIVE_STATUSES } = require('./agent-validators');
const { getAgentRunTitle } = require('./agent-runtime/metadata');
const { currentUserText } = require('./chat-request-constraints');

async function decideAutomaticChatExecution(options = {}, deps = {}) {
    const startedAt = Date.now();
    const config = getChatIntentConfig(deps.config);
    const intentAudit = createChatIntentAudit({ ...options, getTenantId: options.getDecisionTenantId, enqueueObservation: deps.recordDecision });
    const budget = createChatIntentBudget({ signal: options.signal, deadlineAt: options.deadlineAt,
        timeoutMs: config.timeoutMs });
    const intentDiagnostics = {};
    try {
        const decision = await budget.run('total', () => decideWithinIntentBudget({ ...options, intentDiagnostics, intentAudit, signal: budget.signal, deadlineAt: budget.deadlineAt }, { ...deps, budget }));
        return { ...decision, timing: { ...decision.timing, contextMs: Math.max(budget.timings.history || 0, 0) + Math.max(budget.timings.tasks || 0, budget.timings.memories || 0, budget.timings.availability || 0),
            semanticMs: budget.timings.semantic || 0, totalMs: Date.now() - startedAt, stages: { ...budget.timings } } };
    } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : error;
        const baseline = classifyChatAutoExecution({ prompt: options.modelContent });
        const diagnostic = intentDiagnostics.snapshot?.() || {};
        const snapshot = budget.snapshot();
        const failureStage = diagnostic.failureStage || snapshot.stage;
        const timing = { ...diagnostic.timing, totalMs: Date.now() - startedAt, stages: snapshot.timings };
        const failureCode = error.code === 'CHAT_INTENT_TIMEOUT' ? 'intent_timeout' : 'intent_context_unavailable';
        const applied = !options.observeOnly && chatIntentApplies(config, options.userId || options.user?.id, options.sessionId);
        const selected = applied ? buildIntentFallback(baseline, failureCode) : buildUnappliedIntent(baseline, config.mode);
        const durationMs = Date.now() - startedAt;
        intentAudit.record({ selected, applied, mode: config.mode === 'disabled' ? 'disabled' : applied ? 'active' : 'shadow', failure: failureCode,
            failureStage, timing: { ...timing, historyMs: snapshot.timings.history, tasksMs: snapshot.timings.tasks }, durationMs, routingModelId: diagnostic.intentModelId });
        options.log?.warn?.({ sessionId: options.sessionId, userId: options.userId, modelId: options.modelCfg?.id,
            intentModelId: diagnostic.intentModelId, code: error.code, failureStage, timing }, '任务理解超过等待或上下文不可用，已按当前路由配置回退');
        return constrainChatDecision({ ...selected, decisionId: intentAudit.id, failureCode,
            durationMs, failureStage, timing, intentModelId: diagnostic.intentModelId, routingModelSource: diagnostic.routingModelSource },
        resolveChatRequestScope(options.modelContent, { ...(options.requestScope || {}), routeOverrides: options.routeOverrides }));
    } finally { budget.dispose(); }
}

async function decideWithinIntentBudget({
    regenerate = false, ephemeralVoice = false, chatMode = 'normal', agentExecutionAllowed = false,
    autoExecutionEnabled = false, observeOnly = false, modelContent = '', maxGoalLength = 12000,
    sessionId = '', userId = 0, user, userMessageId, modelCfg, signal, deadlineAt, intentDiagnostics, intentAudit, sessionsRepository, log, projectId, writeSse, routeOverrides = {}, mcpToolAllowlist = null, requestScope: suppliedScope = null
} = {}, deps = {}) {
    const intentPrompt = currentUserText(modelContent);
    const providedSources = [...String(modelContent).matchAll(/【参考文档:\s*([^\n】]{1,240})】\s*\n/g)].slice(0, 20).map(match => ({ kind: 'inline_attachment', name: match[1], available: true, sourceMessageId: userMessageId }));
    let requestScope = resolveChatRequestScope(modelContent, { ...(suppliedScope || {}), providedSources, routeOverrides, sourceLength: modelContent.length });
    const initial = classifyChatAutoExecution({ prompt: intentPrompt });
    if (regenerate || ephemeralVoice || chatMode !== 'normal') return { action: 'direct_answer', reasonCode: 'not_evaluated' };
    const correction = detectChatRouteCorrection(intentPrompt, { includeMixed: true });
    if (correction) {
        const corrected = await applyChatRouteCorrection({ correction, intentPrompt, sessionId, userId, user, userMessageId, signal, sessionsRepository, log, writeSse }, deps);
        if (!correction.continueUnderstanding || corrected.action === 'clarify') return corrected;
        routeOverrides = { ...routeOverrides, ...correction.routeOverrides };
    }
    // 停止与遗忘属于用户控制权，关闭自动执行开关也不能使其失效。
    if (['control', 'memory'].includes(initial.action)) return initial;
    // 附件直答只能跳过语义模型，不能跳过对活动任务的显式纠正与来源撤销。
    if (requestScope.directSourceAnswer) return (deps.resolveChatIntent || resolveChatIntent)({ prompt: intentPrompt, providedSources, requestScope,
        sourceLength: modelContent.length, user, modelCfg, sessionId, userMessageId, signal });
    if (isDirectConversation(intentPrompt)) return { ...initial, action: 'direct_answer' };
    writeSse?.(JSON.stringify({ type: 'route', status: 'understanding', message: '正在理解任务并安排处理' }));
    void intentAudit.resolveTenant().catch(() => {});
    const history = (await deps.budget.run('history', () => sessionsRepository.listMessages(sessionId, userId))).filter(item => Number(item.id) !== Number(userMessageId));
    requestScope = resolveChatRequestScope(modelContent, { ...(suppliedScope || {}), providedSources, routeOverrides, history });
    if (requestScope.directSourceAnswer) return (deps.resolveChatIntent || resolveChatIntent)({ prompt: intentPrompt, history, providedSources, requestScope,
        user, modelCfg, sessionId, userMessageId, signal });
    const [tasks, memories, availability] = await Promise.all([
        deps.budget.run('tasks', () => (deps.getConversationTasks || getConversationTasks)(sessionId, userId)),
        deps.budget.run('memories', stageSignal => (deps.retrieveLongTermMemories || retrieveLongTermMemories)(userId, intentPrompt.slice(0, maxGoalLength), { user, sessionId, projectId, limit: 4, signal: stageSignal }),
            { optional: true, fallback: [], timeoutMs: Math.min(2500, deps.budget.remainingMs() / 5) }),
        deps.budget.run('availability', stageSignal => (deps.getChatCapabilityAvailability || getChatCapabilityAvailability)(user, {}, { prompt: intentPrompt, selectedTools: routeOverrides.tools, excludedTools: routeOverrides.excludedTools, excludeTools: routeOverrides.excludeTools, manualAllowlist: mcpToolAllowlist, signal: stageSignal }),
            { optional: true, fallback: { status: 'unavailable', tools: [] }, timeoutMs: Math.min(2500, deps.budget.remainingMs() / 5) })
    ]);
    if (initial.action === 'plan_only') writeSse?.(JSON.stringify({ type: 'route', status: 'plan_only', message: '本轮仅提供计划' }));
    const resolved = await deps.budget.run('semantic', () => (deps.resolveChatIntent || resolveChatIntent)({
        prompt: intentPrompt, history, tasks, modelCfg, user, userMessageId, sessionId, signal, deadlineAt, intentDiagnostics, intentAudit, providedSources,
        availability: { ...availability, tools: (availability.tools || []).filter(tool => toolAllowedByRequestScope(tool, requestScope)) }, requestScope, sourceLength: modelContent.length,
        executionAllowed: agentExecutionAllowed && autoExecutionEnabled, observeOnly,
        preferences: memories.filter(item => item.type === 'preference').map(item => ({ id: item.id, scope: item.scope, content: item.content, version: item.updatedAt }))
    }, { config: deps.config }));
    if (resolved.failureCode) log?.warn?.({ sessionId, userId, modelId: modelCfg?.id, code: resolved.failureCode,
        intentModelId: resolved.intentModelId, durationMs: resolved.durationMs, failureStage: resolved.failureStage, timing: resolved.timing, policyVersion: resolved.policyVersion }, '任务意图判断未完成，已按当前路由配置回退');
    if (!resolved.failureCode && /^(?:不对|不是让你|不是这个意思)|(?:不要|不用).{0,8}(?:新建|另开|新开)任务/.test(intentPrompt)) {
        resolved.correctionEvidence = await deps.budget.run('correctionEvidence', () => (deps.recordChatRouteCorrection || recordChatRouteCorrection)({
            correction: { kind: 'semantic_adjustment', action: resolved.action, routeOverrides: {} }, history, tasks,
            prompt: intentPrompt, userId, sessionId, userMessageId, applied: { status: 'semantic_reroute', action: resolved.action, continuationOf: resolved.continuationOf || null }
        }), { optional: true, fallback: [], timeoutMs: 500 });
    }
    return constrainChatDecision(resolved, requestScope);
}

async function handleAutomaticTaskControl(options = {}, deps = {}) {
    const { decision, sessionId, userId, user, userMessageId, modelCfg, visibleContent,
        persistAssistantResponse, writeSse, finishChatTrace, log, turn, projectId, modelContent } = options;
    if (!['control', 'memory', 'clarify', 'continue_run'].includes(decision?.action)) return { handled: false, decision };
    let content = '';
    try {
        if (decision.action === 'continue_run') {
            const result = await (deps.continueConversationTask || continueConversationTask)({ decision, user, sessionId, userMessageId, instruction: visibleContent, sourceContent: modelContent,
                routeOverrides: options.routeOverrides, mcpToolAllowlist: options.mcpToolAllowlist });
            if (result.continued) {
                await ledger.updateTurn(turn, { run_id: result.run.id, conversation_task_id: result.conversationTaskId });
                content = result.pendingApproval ? '已补充本次要求；当前任务仍在等待原有审批决定。' : '已将本次要求交给当前任务继续处理。';
            } else {
                if (!result.previousRun) content = '没有找到可继续的当前任务，请说明需要处理的目标。';
                else {
                    const prior = typeof result.previousRun.metadata === 'string' ? JSON.parse(result.previousRun.metadata) : result.previousRun.metadata || {};
                    return { handled: false, decision: { ...decision, action: 'agent_run', conversationTaskId: prior.conversationTaskId || result.previousRun.id,
                        completedWork: { runId: result.previousRun.id, goal: result.previousRun.goal, answer: String(result.previousRun.final_answer || '').slice(0, 8000), workingState: prior.workingState || null }, reasonCode: 'completed_task_followup' } };
                }
            }
        }
        if (decision.action === 'control') {
            const tasks = await (deps.listSessionTasks || ledger.listSessionTasks)(sessionId, userId, { activeOnly: true });
            const active = tasks.filter(run => ACTIVE_STATUSES.has(run.status));
            const target = decision.controlTarget;
            const matches = target ? active.filter(run => [run.id, getAgentRunTitle(run)].includes(target)) : active;
            if (!active.length) content = '当前会话没有正在处理的任务。';
            else if (!matches.length) content = '当前会话没有找到这个活动任务，请核对名称或在任务卡上操作。';
            else if (matches.length > 1) content = target ? '有多项活动任务使用此名称，请在对应任务卡上操作。' : '当前有多项任务正在处理，请指出要停止的任务名称。';
            else {
                const runtime = deps.runtime || require('./agent-runtime').runs;
                const control = decision.control === 'pause' ? runtime.pauseAgentRun : runtime.cancelAgentRun;
                const run = await control(matches[0].id, user);
                content = run?.status === 'cancelled' ? '已停止当前任务的后续处理；已经完成的操作保留记录。'
                    : run?.status === 'needs_input' ? '已暂停当前任务，可以随后继续。'
                    : run?.status === 'awaiting_commit' ? '当前任务正在等待提交决定，请在任务详情中确认提交或回滚。'
                    : /approval/.test(run?.status || '') ? '当前任务正在等待审批，请在任务详情中处理审批。'
                    : run && !ACTIVE_STATUSES.has(run.status) ? '任务已结束，无需再次停止。'
                    : '任务状态已变化，尚未确认停止，请在任务详情查看状态后重试。';
            }
        } else if (decision.action === 'memory') {
            const result = await (deps.handleChatMemoryRequest || handleChatMemoryRequest)({ prompt: visibleContent, user, sessionId, userMessageId, projectId });
            content = result.content;
        } else if (decision.action === 'clarify') content = decision.question || '请补充任务需要处理的对象或期望结果。';
    } catch (error) {
        log?.warn?.({ sessionId, userId, code: error.code }, '对话控制操作未完成');
        content = error.code === 'AGENT_TASK_COMMIT_DECISION_REQUIRED'
            ? '任务已暂停在外部动作提交边界，请在任务详情中决定提交或回滚。'
            : error.code === 'AGENT_TASK_RESUME_EFFECT_REVIEW_REQUIRED' ? '本次要求已保存；任务仍有待核对的外部动作或预览，请在事务详情处理后继续。'
            : '本次操作未完成，请稍后重试或在任务、记忆详情中查看状态。';
    }
    const { assistantMessageResult, assistantMessageId } = await persistAssistantResponse({
        sessionId, userId, userMessageId, user, modelCfg, visibleContent, assistantContent: content, assistantTokens: estimateTokens(content),
        skipMemoryExtraction: ['memory', 'control'].includes(decision.action),
        skipTitleGeneration: decision.action === 'control',
        routeMetadata: { decisions: decision.decisionId ? [{ decisionId: decision.decisionId, scenario: 'chat.execution', selectedActionId: decision.action }] : [] }
    });
    if (decision.decisionId) recordDecisionOutcome({ decisionId: decision.decisionId, source: 'runtime', eventType: 'execution', status: 'partial', reasonCode: decision.reasonCode || decision.action, resultReference: String(assistantMessageId) });
    writeSse?.(JSON.stringify({ type: 'message_saved', role: 'assistant', messageId: assistantMessageId || assistantMessageResult?.lastInsertRowid, content, modelName: modelCfg.name || '' }));
    writeSse?.('[DONE]');
    finishChatTrace?.('completed', { mode: 'conversation_action', action: decision.action });
    return { handled: true, decision };
}

module.exports = { decideAutomaticChatExecution, handleAutomaticTaskControl, applyAutomaticExecutionDecision };
