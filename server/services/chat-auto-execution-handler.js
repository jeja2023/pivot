'use strict';

const { estimateTokens } = require('../llm');
const { cancelAgentRun } = require('./agent-runtime').runs;
const { classifyChatAutoExecution } = require('./chat-auto-execution');
const { getAgentProfile } = require('./agent-profile');
const { listChatAgentRunsForSession } = require('./chat-agent-bridge');

/**
 * 在用户消息持久化后解析执行载体。
 * 保持聊天路由专注于传输，同时保留单一的服务端决策。
 */
async function decideAutomaticChatExecution({
    regenerate = false,
    ephemeralVoice = false,
    chatMode = 'normal',
    agentExecutionAllowed = false,
    autoExecutionEnabled = false,
    modelContent = '',
    maxGoalLength = 12000,
    sessionId = '',
    userId = 0,
    _user,
    sessionsRepository,
    log
} = {}) {
    const fallback = { action: 'direct_answer', confidence: 0, reasonCode: 'not_evaluated' };
    if (regenerate || ephemeralVoice || chatMode !== 'normal' || !agentExecutionAllowed || !autoExecutionEnabled || String(modelContent).length > maxGoalLength) return fallback;
    try {
        const history = await sessionsRepository.listMessages(sessionId, userId);
        const initial = classifyChatAutoExecution({ prompt: modelContent, history });
        let profile = {};
        if (initial.action === 'agent_run' || initial.reasonCode === 'insufficient_execution_evidence') {
            profile = await getAgentProfile(userId).catch(() => ({}));
        }
        return classifyChatAutoExecution({ prompt: modelContent, history, profile });
    } catch (error) {
        log?.warn?.({ sessionId, userId, err: error.message }, '自动任务路由不可用，已回退普通对话');
        return { action: 'direct_answer', confidence: 0, reasonCode: 'decision_unavailable' };
    }
}

/**
 * 仅在当前会话存在真实活跃的任务运行时，才处理自然语言停止指令；
 * 否则调用方继续普通聊天。
 */
async function handleAutomaticTaskControl({
    decision,
    sessionId,
    userId,
    user,
    userMessageId,
    modelCfg,
    visibleContent,
    persistAssistantResponse,
    writeSse,
    finishChatTrace,
    log
} = {}) {
    if (decision?.action !== 'control' || decision?.control !== 'stop') return { handled: false, decision };
    try {
        const activeRuns = await listChatAgentRunsForSession(sessionId, userId, { limit: 20 });
        const activeRun = activeRuns[0] || null;
        if (!activeRun) return { handled: false, decision: { action: 'direct_answer', confidence: 0, reasonCode: 'no_active_task_to_stop' } };
        await cancelAgentRun(activeRun.id, user);
        const assistantContent = '已停止当前正在处理的任务。';
        const { assistantMessageResult, assistantMessageId } = await persistAssistantResponse({
            sessionId,
            userId,
            userMessageId,
            user,
            modelCfg,
            visibleContent,
            assistantContent,
            assistantTokens: estimateTokens(assistantContent)
        });
        finishChatTrace?.('completed', { mode: 'automatic_task_control', action: 'stop', runId: activeRun.id });
        writeSse?.(JSON.stringify({
            type: 'message_saved',
            role: 'assistant',
            messageId: assistantMessageId || assistantMessageResult?.lastInsertRowid,
            modelName: modelCfg.name || modelCfg.model_name || '',
            tokenCount: estimateTokens(assistantContent),
            content: assistantContent,
            taskControl: { action: 'stop', runId: activeRun.id }
        }));
        writeSse?.('[DONE]');
        return { handled: true, runId: activeRun.id, decision };
    } catch (error) {
        log?.warn?.({ sessionId, userId, err: error.message }, '自然语言停止任务失败，已回退普通回答');
        return { handled: false, decision: { action: 'direct_answer', confidence: 0, reasonCode: 'task_control_unavailable' } };
    }
}

module.exports = {
    decideAutomaticChatExecution,
    handleAutomaticTaskControl
};
