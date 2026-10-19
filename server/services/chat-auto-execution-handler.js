'use strict';

const { estimateTokens } = require('../llm');
const { classifyChatAutoExecution } = require('./chat-auto-execution');
const { resolveChatIntent } = require('./chat-intent-resolver');
const { getConversationTasks, continueConversationTask } = require('./chat-task-continuation');
const { handleChatMemoryRequest } = require('./chat-memory-actions');
const { retrieveLongTermMemories } = require('./long-term-memory');
const { recordDecisionOutcome } = require('./decision-observability');
const ledger = require('../repositories/chat-conversation-turns');

async function decideAutomaticChatExecution({
    regenerate = false, ephemeralVoice = false, chatMode = 'normal', agentExecutionAllowed = false,
    autoExecutionEnabled = false, modelContent = '', maxGoalLength = 12000,
    sessionId = '', userId = 0, user, userMessageId, modelCfg, signal, sessionsRepository, log, projectId, writeSse
} = {}, deps = {}) {
    const intentPrompt = String(modelContent).split(/\n---\s*\n【参考文档/)[0];
    const providedSources = [...String(modelContent).matchAll(/【参考文档:\s*([^\n】]{1,240})】\s*\n/g)].slice(0, 20).map(match => ({ kind: 'inline_attachment', name: match[1], available: true, sourceMessageId: userMessageId }));
    const initial = classifyChatAutoExecution({ prompt: intentPrompt });
    if (regenerate || ephemeralVoice || chatMode !== 'normal') return { action: 'direct_answer', reasonCode: 'not_evaluated' };
    // 停止与遗忘属于用户控制权，关闭自动执行开关也不能使其失效。
    if (['control', 'memory'].includes(initial.action)) return initial;
    if (!agentExecutionAllowed || !autoExecutionEnabled || intentPrompt.length > maxGoalLength || initial.action === 'direct_answer') return { ...initial, action: 'direct_answer' };
    writeSse?.(JSON.stringify({ type: 'route', status: 'understanding', message: '正在理解任务并安排处理' }));
    try {
        const history = (await sessionsRepository.listMessages(sessionId, userId)).filter(item => Number(item.id) !== Number(userMessageId));
        const [tasks, memories] = await Promise.all([
            (deps.getConversationTasks || getConversationTasks)(sessionId, userId),
            (deps.retrieveLongTermMemories || retrieveLongTermMemories)(userId, intentPrompt, { user, sessionId, projectId, limit: 4 }).catch(() => [])
        ]);
        if (initial.contextualOnly && !tasks.some(task => task.active)) return { ...initial, action: 'direct_answer', reasonCode: 'contextual_reply' };
        if (initial.action === 'plan_only' && /这次|这轮|当前|刚才|不要|先别/.test(modelContent)) {
            const active = tasks.filter(task => task.active);
            if (active.length === 1) {
                const { updateAgentRunMetadataWithRetry } = require('./agent-run-metadata-patch');
                await updateAgentRunMetadataWithRetry(active[0].id, metadata => ({ ...metadata,
                    capabilityConstraints: { ...(metadata.capabilityConstraints || {}), present: true, capabilities: [], authorizationRef: `user_message:${userMessageId}`, sourceMessageId: userMessageId }
                }), { userId });
                await (deps.pauseAgentRun || require('./agent-runtime').runs.pauseAgentRun)(active[0].id, user);
            }
        }
        if (initial.action === 'plan_only') writeSse?.(JSON.stringify({ type: 'route', status: 'plan_only', message: '本轮仅提供计划' }));
        return await (deps.resolveChatIntent || resolveChatIntent)({
            prompt: intentPrompt, history, tasks, modelCfg, user, userMessageId, sessionId, signal, providedSources,
            preferences: memories.filter(item => item.type === 'preference').map(item => ({ id: item.id, scope: item.scope, content: item.content, version: item.updatedAt }))
        });
    } catch (error) {
        if (signal?.aborted) throw error;
        log?.warn?.({ sessionId, userId, code: error.code }, '自动任务语义路由不可用');
        return { ...initial, action: 'clarify', reasonCode: 'decision_unavailable', question: '任务理解服务暂时不可用，请稍后重试；你的请求已保存。' };
    }
}

async function handleAutomaticTaskControl(options = {}, deps = {}) {
    const { decision, sessionId, userId, user, userMessageId, modelCfg, visibleContent,
        persistAssistantResponse, writeSse, finishChatTrace, log, turn, projectId, modelContent } = options;
    if (!['control', 'memory', 'clarify', 'continue_run'].includes(decision?.action)) return { handled: false, decision };
    let content = '';
    try {
        if (decision.action === 'continue_run') {
            const result = await (deps.continueConversationTask || continueConversationTask)({ decision, user, sessionId, userMessageId, instruction: visibleContent, sourceContent: modelContent });
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
            const tasks = await (deps.listSessionTasks || ledger.listSessionTasks)(sessionId, userId);
            const active = tasks.filter(run => ['queued','planning','running','executing','observing','diagnosing','replanning','resuming','needs_input','approval_required','waiting_approval','awaiting_approval','awaiting_commit'].includes(run.status));
            if (!active.length) content = '当前会话没有正在处理的任务。';
            else if (active.length > 1) content = '当前有多项任务正在处理，请指出要停止的任务名称。';
            else {
                const runtime = deps.runtime || require('./agent-runtime').runs;
                const control = decision.control === 'pause' ? runtime.pauseAgentRun : runtime.cancelAgentRun;
                const run = await control(active[0].id, user);
                content = run?.status === 'cancelled' ? '已停止当前任务的后续处理；已经完成的操作保留记录。'
                    : run?.status === 'needs_input' ? '已暂停当前任务，可以随后继续。' : '任务已结束，无需再次停止。';
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
        routeMetadata: { decisions: decision.decisionId ? [{ decisionId: decision.decisionId, scenario: 'chat.execution', selectedActionId: decision.action }] : [] }
    });
    if (decision.decisionId) recordDecisionOutcome({ decisionId: decision.decisionId, source: 'runtime', eventType: 'execution', status: 'partial', reasonCode: decision.reasonCode || decision.action, resultReference: String(assistantMessageId) });
    writeSse?.(JSON.stringify({ type: 'message_saved', role: 'assistant', messageId: assistantMessageId || assistantMessageResult?.lastInsertRowid, content, modelName: modelCfg.name || '' }));
    writeSse?.('[DONE]');
    finishChatTrace?.('completed', { mode: 'conversation_action', action: decision.action });
    return { handled: true, decision };
}

module.exports = { decideAutomaticChatExecution, handleAutomaticTaskControl };
