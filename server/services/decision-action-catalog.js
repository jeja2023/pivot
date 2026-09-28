'use strict';

const { normalizeActionId } = require('./decision-provider');

const ACTION_CATALOG = Object.freeze({
    'chat.rag': Object.freeze({
        retrieve: Object.freeze({ id: 'retrieve', type: 'knowledge_retrieval', source: 'semantic_router_rag', description: '在已授权的知识库范围内检索证据', successDefinition: '检索到可引用依据，并由后续业务结果或人工核验确认路径正确。' }),
        skip: Object.freeze({ id: 'skip', type: 'knowledge_retrieval', source: 'semantic_router_rag', description: '本轮不执行知识库检索，继续受控回退路径', successDefinition: '后续回答不要求知识库依据，且经业务结果或人工核验确认无需检索。' })
    }),
    'chat.tools': Object.freeze({
        propose: Object.freeze({ id: 'propose', type: 'tool_selection', source: 'semantic_router_tools', description: '将已授权工具候选交给现有 MCP 规划和审批链路', successDefinition: '工具规划和执行完成，结果经业务结果或人工核验被确认采用。' }),
        candidate_only: Object.freeze({ id: 'candidate_only', type: 'tool_selection', source: 'semantic_router_tools', description: '提示用户确认工具库授权，不执行任何工具', successDefinition: '用户在需要时完成授权，后续执行使用受控候选；未授权本身不是成功标签。' }),
        skip: Object.freeze({ id: 'skip', type: 'tool_selection', source: 'semantic_router_tools', description: '本轮不选择工具候选', successDefinition: '任务不需要外部工具，且经业务结果或人工核验确认无需工具。' })
    }),
    'chat.next_step': Object.freeze({
        direct_answer: Object.freeze({ id: 'direct_answer', type: 'chat_next_step', source: 'semantic_router_next_step', description: '由 Qwen 直接生成最终回答', successDefinition: '用户或业务流程确认问题已解决；模型自行完成或用户沉默均不构成标签。' }),
        clarify: Object.freeze({ id: 'clarify', type: 'chat_next_step', source: 'semantic_router_next_step', description: '提出澄清问题后再继续', successDefinition: '缺失信息被补齐，后续业务结果或人工核验确认澄清必要。' }),
        workflow: Object.freeze({ id: 'workflow', type: 'workflow_selection', source: 'published_workflow_recommender', description: '选择已授权业务工作流', successDefinition: '工作流成功产出并被业务采用，或人工复核确认选用正确。' })
    })
});

function getDecisionActionDefinition(scenario, actionId) {
    const safeScenario = String(scenario || '').trim();
    const safeActionId = normalizeActionId(actionId);
    const definition = ACTION_CATALOG[safeScenario]?.[safeActionId];
    return definition ? { ...definition } : null;
}

function buildDecisionActionCandidate(scenario, actionId, overrides = {}) {
    const definition = getDecisionActionDefinition(scenario, actionId);
    if (!definition) return null;
    return {
        ...definition,
        risk: overrides.risk || 'low',
        requiresApproval: overrides.requiresApproval === true,
        allowed: overrides.allowed !== false
    };
}

function listDecisionActions(scenario) {
    return Object.values(ACTION_CATALOG[String(scenario || '').trim()] || {}).map(item => ({ ...item }));
}

module.exports = {
    buildDecisionActionCandidate,
    listDecisionActions
};
