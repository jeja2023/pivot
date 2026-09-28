'use strict';

const { buildDecisionActionCandidate } = require('./decision-action-catalog');
const { getPrimaryTenantId } = require('./enterprise-access');
const { resolveBusinessDecision } = require('./decision-runtime');
const { buildStructuredTaskState } = require('./structured-task-state');
const { listAgentWorkflows } = require('./agent-workflows');

function tokens(value = '') {
    const text = String(value || '').toLowerCase();
    const output = new Set(text.match(/[a-z0-9_./-]{2,}/g) || []);
    const chinese = text.replace(/[^\u4e00-\u9fff]/g, '');
    for (let index = 0; index < chinese.length - 1; index += 1) output.add(chinese.slice(index, index + 2));
    return output;
}

function overlapScore(query = '', candidate = '') {
    const left = tokens(query);
    const right = tokens(candidate);
    if (!left.size || !right.size) return 0;
    let common = 0;
    left.forEach(token => { if (right.has(token)) common += 1; });
    return common / Math.max(1, Math.min(left.size, right.size));
}

function publishedWorkflowCandidates(workflows = [], taskState = {}, maxCandidates = 8) {
    const query = [taskState.retrievalQuery, taskState.currentQuestion, taskState.goal].filter(Boolean).join(' ');
    const max = Math.max(1, Math.min(Number.parseInt(maxCandidates, 10) || 8, 24));
    return (Array.isArray(workflows) ? workflows : [])
        .filter(workflow => workflow?.is_published === true && Number.isSafeInteger(Number(workflow.id)))
        .map(workflow => {
            const name = String(workflow.name || '').trim();
            const description = String(workflow.description || '').trim();
            return {
                id: 'workflow:' + Number(workflow.id),
                type: 'workflow_selection',
                source: 'published_workflow_catalog',
                description: (name + (description ? '：' + description : '')).slice(0, 400),
                allowed: true,
                workflowId: Number(workflow.id),
                workflowName: name,
                score: overlapScore(query, name + '\n' + description)
            };
        })
        .sort((left, right) => right.score - left.score || left.workflowName.localeCompare(right.workflowName) || left.workflowId - right.workflowId)
        .slice(0, max);
}

async function recommendPublishedWorkflow({ user, prompt = '', taskState = null, modelCfg = null, sessionId = '', env = process.env, signal = null, maxCandidates = 8 } = {}, deps = {}) {
    if (!user?.id) throw new Error('workflow_recommendation_user_required');
    const structured = taskState && typeof taskState === 'object'
        ? taskState
        : buildStructuredTaskState({ prompt });
    const workflows = await (deps.listAgentWorkflows || listAgentWorkflows)(user, {});
    const workflowCandidates = publishedWorkflowCandidates(workflows, structured, maxCandidates);
    const candidates = [
        buildDecisionActionCandidate('chat.next_step', 'direct_answer', { allowed: true }),
        buildDecisionActionCandidate('chat.next_step', 'clarify', { allowed: true }),
        ...workflowCandidates
    ].filter(Boolean);
    let tenantId = user.tenant_id || null;
    if (!tenantId) {
        try { tenantId = await (deps.getPrimaryTenantId || getPrimaryTenantId)(user.id); } catch (_) {}
    }
    const actionScores = Object.fromEntries(candidates.map(candidate => [candidate.id, candidate.id === 'direct_answer' ? 0.7 : candidate.id === 'clarify' ? 0.2 : Math.min(0.65, 0.15 + candidate.score)]));
    const decision = await (deps.resolveBusinessDecision || resolveBusinessDecision)({
        scenario: 'agent.workflow',
        taskState: structured,
        tenantId,
        userId: user.id,
        user,
        sessionId,
        modelCfg,
        candidates,
        fallbackActionId: 'direct_answer',
        actionScores,
        env,
        signal
    }, { user, ...deps });
    const recommendationActionId = decision.policy?.mode === 'shadow'
        ? decision.policy?.suggestedActionId || decision.selectedActionId
        : decision.selectedActionId;
    const selectedWorkflow = workflowCandidates.find(candidate => candidate.id === recommendationActionId) || null;
    return {
        decision,
        executionActionId: decision.selectedActionId,
        recommendationActionId,
        selectedWorkflow: selectedWorkflow ? { id: selectedWorkflow.workflowId, name: selectedWorkflow.workflowName } : null,
        candidates: workflowCandidates.map(({ score: _score, ...candidate }) => candidate),
        requiresUserConfirmation: Boolean(selectedWorkflow)
    };
}

module.exports = {
    publishedWorkflowCandidates,
    recommendPublishedWorkflow
};
