'use strict';

const { getConversationTasks } = require('./chat-task-continuation');
const { recordChatRouteCorrection, correctionRetrievalQuery } = require('./chat-route-correction');

async function applyChatRouteCorrection({ correction, intentPrompt, sessionId, userId, user, userMessageId, signal, sessionsRepository, log, writeSse }, deps = {}) {
    let history = [];
    let tasks = [];
    const applied = { pausedRunIds: [], restrictedRunIds: [], status: 'applied' };
    try {
        // 纠正属于当前用户的控制权，不受自动执行开关和新建任务权限影响。
        tasks = await (deps.budget ? deps.budget.run('correctionTasks', () => (deps.getConversationTasks || getConversationTasks)(sessionId, userId))
            : (deps.getConversationTasks || getConversationTasks)(sessionId, userId));
        if (signal?.aborted) throw signal.reason;
        const active = tasks.filter(task => task.active);
        if (active.length > 1) return { action: 'clarify', reasonCode: 'multiple_correction_targets',
            question: '当前有多项任务，请指出需要调整的任务名称。', correction, constraints: [correction.constraint] };
        for (const task of active) {
            if (signal?.aborted) throw signal.reason;
            await (deps.updateMetadata || require('./agent-run-metadata-patch').updateAgentRunMetadataWithRetry)(task.id, metadata => ({ ...metadata,
                ...(correction.pauseExecution ? { capabilityConstraints: { ...(metadata.capabilityConstraints || {}), present: true, capabilities: [], authorizationRef: `user_message:${userMessageId}`, sourceMessageId: userMessageId } } : {}),
                ...(!correction.pauseExecution ? { capabilityConstraints: { ...(metadata.capabilityConstraints || {}),
                    ...(correction.routeOverrides.excludeRag ? { excludeKnowledge: true } : {}), ...(correction.routeOverrides.excludeWeb ? { excludeWeb: true } : {}), ...(correction.routeOverrides.excludeData ? { excludeData: true } : {}),
                    authorizationRef: `user_message:${userMessageId}`, sourceMessageId: userMessageId } } : {}),
                ...(correction.routeOverrides.excludeRag ? { chatBridge: { ...metadata.chatBridge, ragEnabled: false, ragContext: '' } } : {}),
                taskContract: { ...(metadata.taskContract || {}), constraints: [...new Set([...(metadata.taskContract?.constraints || []), correction.constraint])].slice(-24) },
                routeCorrection: { kind: correction.kind, sourceMessageId: userMessageId, routeOverrides: correction.routeOverrides }
            }), { userId });
            if (signal?.aborted) throw signal.reason;
            if (!correction.pauseExecution) {
                await (deps.sendAgentControlMessage || require('./agent-control').sendAgentControlMessage)({ user, toRunId: task.id, type: 'steer',
                    idempotencyKey: `chat-correction:${sessionId}:${userMessageId}`, payload: { instruction: correction.constraint, source: 'chat', sourceMessageId: userMessageId } });
                continue;
            }
            applied.restrictedRunIds.push(task.id);
            const paused = await (deps.pauseAgentRun || require('./agent-runtime').runs.pauseAgentRun)(task.id, user);
            if (!paused) throw new Error('纠正对象已经不可用');
            if (paused.status === 'needs_input') applied.pausedRunIds.push(task.id);
            else if (/^(?:queued|planning|running|executing|observing|diagnosing|replanning|resuming)$/.test(paused.status)) throw new Error('暂停尚未确认');
        }
    } catch (error) {
        if (signal?.aborted) throw error;
        log?.warn?.({ sessionId, userId, code: error.code }, '当前任务纠正未能完整应用');
        return { action: 'clarify', reasonCode: 'correction_apply_failed', correction,
            question: '本轮已限制处理方式，但当前任务的暂停尚未确认，请在任务详情查看状态后重试。', constraints: [correction.constraint] };
    }
    let evidence = [];
    try {
        history = (await sessionsRepository.listMessages(sessionId, userId)).filter(item => Number(item.id) !== Number(userMessageId));
        if (signal?.aborted) throw signal.reason;
        if (correction.routeOverrides.forceRag) correction.retrievalQuery = correctionRetrievalQuery(intentPrompt, history);
        evidence = await (deps.recordChatRouteCorrection || recordChatRouteCorrection)({ correction, history, tasks, prompt: intentPrompt, userId, sessionId, userMessageId, applied });
    } catch (error) {
        if (signal?.aborted) throw error;
        log?.warn?.({ sessionId, userId, code: error.code }, '当前任务纠正已生效，后台证据记录暂不可用');
    }
    if (signal?.aborted) throw signal.reason;
    writeSse?.(JSON.stringify({ type: 'route', status: 'corrected', message: applied.pausedRunIds.length ? '已暂停当前任务，并按本次要求调整处理方式' : '已按本次要求调整处理方式' }));
    return { version: 2, action: correction.action, reasonCode: 'natural_route_correction', objective: intentPrompt,
        ...(correction.action === 'plan_only' ? { routing: { version: 1, source: 'semantic_intent', knowledge: 'none', tools: 'none', retrievalQuery: intentPrompt, requestedCapabilities: [], toolNames: [], requireEvidence: false, allowAutomaticRead: false } } : {}),
        requiredCapabilities: [], constraints: [correction.constraint], correction: { ...correction, ...applied, evidence } };
}

module.exports = { applyChatRouteCorrection };
