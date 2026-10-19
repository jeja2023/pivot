'use strict';

const turns = require('../repositories/chat-conversation-turns');
const { sendAgentControlMessage, claimAgentControlMessages, applyAgentControlMessages, acknowledgeAppliedAgentControlMessages } = require('./agent-control');
const { updateAgentRunMetadataWithRetry } = require('./agent-run-metadata-patch');
const { buildAgentResumeContext } = require('./agent-checkpoints');

const ACTIVE = new Set(['queued','planning','running','executing','observing','diagnosing','replanning','resuming','needs_input','approval_required','waiting_approval','awaiting_approval','awaiting_commit']);
const parseConversationRunMetadata = value => typeof value === 'string' ? JSON.parse(value) : value || {};

async function getConversationTasks(sessionId, userId) {
    return (await turns.listSessionTasks(sessionId, userId)).map(run => {
        const metadata = parseConversationRunMetadata(run.metadata);
        return { id: run.id, status: run.status, goal: String(run.goal).slice(0, 1600), conversationTaskId: metadata.conversationTaskId || run.id, active: ACTIVE.has(run.status), constraints: metadata.taskContract?.constraints || [], decisionId: metadata.automaticExecution?.decisionId || null };
    });
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
        const controls = await claimAgentControlMessages(run.id, user);
        if (controls.length) {
            const applied = await applyAgentControlMessages(run.id, user, controls);
            await acknowledgeAppliedAgentControlMessages(run.id, user, applied);
        }
        const fresh = await turns.currentExecutionScope(run.id, user.id);
        const revisedMetadata = parseConversationRunMetadata(fresh?.metadata);
        if (revisedMetadata.taskTransactionId) await require('./agent-task-transactions').resumeTaskTransactionAfterInput(revisedMetadata.taskTransactionId, user, revisedMetadata.taskContract);
        const resumeContext = await (deps.buildAgentResumeContext || buildAgentResumeContext)(run.id);
        await (deps.updateMetadata || updateAgentRunMetadataWithRetry)(run.id, current => ({ ...current, resumeContext }), { userId: user.id });
        const changed = await (deps.requeueWaitingTask || turns.requeueWaitingTask)(run.id, user.id);
        if (changed) {
            const runtime = require('./agent-runtime');
            if (deps.enqueueAgentRun) deps.enqueueAgentRun(run.id, user);
            else runtime.monitoring.getAgentQueue().enqueueRun(run.id);
        }
    }
    return { continued: true, run, conversationTaskId: metadata.conversationTaskId || run.id, pendingApproval: /approval|commit/.test(run.status) };
}

module.exports = { getConversationTasks, continueConversationTask };
