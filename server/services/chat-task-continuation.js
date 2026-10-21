'use strict';

const turns = require('../repositories/chat-conversation-turns');
const { sendAgentControlMessage, claimAgentControlMessages, applyAgentControlMessages, acknowledgeAppliedAgentControlMessages } = require('./agent-control');
const { updateAgentRunMetadataWithRetry } = require('./agent-run-metadata-patch');
const { buildAgentResumeContext } = require('./agent-checkpoints');
const { getAgentRunResources } = require('./agent-run-resources');
const { normalizeTaskBudget } = require('./agent-budget');

const ACTIVE = new Set(['queued','planning','running','executing','observing','diagnosing','replanning','verifying','resuming','needs_input','approval_required','waiting_approval','awaiting_approval','awaiting_commit']);
const parseConversationRunMetadata = value => typeof value === 'string' ? JSON.parse(value) : value || {};

async function getConversationTasks(sessionId, userId) {
    return (await turns.listSessionTasks(sessionId, userId)).map(run => {
        const metadata = parseConversationRunMetadata(run.metadata);
        return { id: run.id, status: run.status, goal: String(run.goal).slice(0, 1600), conversationTaskId: metadata.conversationTaskId || run.id, active: ACTIVE.has(run.status),
            constraints: metadata.taskContract?.constraints || [], deliverables: metadata.taskContract?.deliverables || [], acceptance: metadata.taskContract?.acceptance || {},
            requiredCapabilities: metadata.capabilityConstraints?.capabilities || [], decisionId: metadata.automaticExecution?.decisionId || null };
    });
}

async function resumeWaitingConversationTask(run, user, deps = {}) {
    const resources = await (deps.getAgentRunResources || getAgentRunResources)(run.id, user.id);
    const budget = normalizeTaskBudget(parseConversationRunMetadata(run.budget_config));
    const limit = Math.min(budget.max_tokens_total, Number(run.max_token_budget) > 0 ? Number(run.max_token_budget) : Infinity);
    const consumed = Math.max(Number(resources?.tokens_consumed || 0), Number(run.total_tokens || 0));
    if (consumed + Number(resources?.tokens_reserved || 0) >= limit) {
        throw Object.assign(new Error(Number(resources?.tokens_reserved || 0) > 0
            ? '剩余额度已分配给子任务，请在任务详情中查看并继续最新任务。'
            : '本任务累计 Token 预算已用完，请缩小资料范围后重新提问。'), {
            code: 'AGENT_BUDGET_EXCEEDED', category: 'resource', status: 409
        });
    }
    const controls = await (deps.claimAgentControlMessages || claimAgentControlMessages)(run.id, user);
    if (controls.length) {
        const applied = await (deps.applyAgentControlMessages || applyAgentControlMessages)(run.id, user, controls);
        await (deps.acknowledgeAppliedAgentControlMessages || acknowledgeAppliedAgentControlMessages)(run.id, user, applied);
    }
    const fresh = await (deps.currentExecutionScope || turns.currentExecutionScope)(run.id, user.id);
    if (!fresh || fresh.status !== 'needs_input') return false;
    const revisedMetadata = parseConversationRunMetadata(fresh.metadata);
    if (revisedMetadata.taskTransactionId) {
        await (deps.resumeTaskTransactionAfterInput || require('./agent-task-transactions').resumeTaskTransactionAfterInput)(revisedMetadata.taskTransactionId, user, revisedMetadata.taskContract);
    }
    const resumeContext = await (deps.buildAgentResumeContext || buildAgentResumeContext)(run.id);
    await (deps.updateMetadata || updateAgentRunMetadataWithRetry)(run.id, current => ({
        ...current,
        resumeContext: { ...resumeContext, previousStatus: run.status, previousAnswer: String(run.final_answer || '').slice(0, 4000), previousError: run.error_message || '' }
    }), { userId: user.id });
    // 同一运行只认领一次队列位置；重复点击不创建子任务，也不重新预留整份余额。
    const changed = await (deps.requeueWaitingTask || turns.requeueWaitingTask)(run.id, user.id, Number(resumeContext.latestStepIndex || 0));
    if (changed) {
        if (deps.enqueueAgentRun) deps.enqueueAgentRun(run.id, user);
        else require('./agent-runtime').monitoring.getAgentQueue().enqueueRun(run.id);
    }
    return Boolean(changed);
}

async function continueConversationTask({ decision, user, sessionId, userMessageId, instruction, sourceContent = '' }, deps = {}) {
    const tasks = await (deps.listSessionTasks || turns.listSessionTasks)(sessionId, user.id);
    const run = tasks.find(item => item.id === decision.continuationOf);
    if (!run) return { continued: false, reason: 'task_not_active' };
    if (!ACTIVE.has(run.status)) return { continued: false, reason: 'task_completed', previousRun: run };
    const metadata = parseConversationRunMetadata(run.metadata);
    const idempotencyKey = `chat:${sessionId}:${userMessageId}`;
    const taskContractPatch = { goal: decision.objective || run.goal, constraints: decision.constraints || [], deliverables: decision.deliverables || [],
        acceptance: { ...decision.acceptance, requireSemanticVerification: true,
            requireCompleteSource: metadata.taskContract?.acceptance?.requireCompleteSource === true || sourceContent.length > 12000 }, authorizationRef: `user_message:${userMessageId}` };
    await (deps.sendAgentControlMessage || sendAgentControlMessage)({ user, toRunId: run.id, type: 'steer', idempotencyKey, payload: { instruction, source: 'chat', sourceMessageId: userMessageId, taskContractPatch } });
    await (deps.updateMetadata || updateAgentRunMetadataWithRetry)(run.id, current => ({
        ...current,
        conversationTaskId: current.conversationTaskId || run.id,
        requiredSourceMessages: [...new Set([...(current.requiredSourceMessages || []), ...(sourceContent.length > 12000 ? [userMessageId] : [])])],
        ...(current.capabilityConstraints?.present === true && Array.isArray(decision.requiredCapabilities) ? { capabilityConstraints: { ...current.capabilityConstraints, capabilities: decision.requiredCapabilities, authorizationRef: `user_message:${userMessageId}`, sourceMessageId: userMessageId } } : {}),
        conversationMessageIds: [...new Set([...(current.conversationMessageIds || []), userMessageId])].slice(-100)
    }), { userId: user.id });
    if (run.status === 'needs_input') {
        await resumeWaitingConversationTask(run, user, deps);
    }
    return { continued: true, run, conversationTaskId: metadata.conversationTaskId || run.id, pendingApproval: /approval|commit/.test(run.status) };
}

module.exports = { getConversationTasks, continueConversationTask, resumeWaitingConversationTask };
