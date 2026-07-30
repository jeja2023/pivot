const { db } = require('../../db');
const { normalizeDagSpec } = require('../agent-validators');

function inferDagRunGoal({ goal, title, workflowId, runMetadata = {}, dagSpec = null, user = {} }) {
    const explicitGoal = String(goal || '').trim();
    if (explicitGoal) return explicitGoal;
    const metadataWorkflowName = String(runMetadata.workflowName || runMetadata.workflow_name || '').trim();
    if (metadataWorkflowName) return `执行工作流：${metadataWorkflowName}`;
    const requestedWorkflowId = Number.parseInt(workflowId || runMetadata.workflowId || runMetadata.workflow_id, 10);
    if (requestedWorkflowId && user?.id) {
        const workflow = db.prepare('SELECT name FROM agent_workflows WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
            .get(requestedWorkflowId, user.id);
        if (workflow?.name) return `执行工作流：${workflow.name}`;
    }
    const cleanTitle = String(title || '').trim();
    if (cleanTitle) return cleanTitle;
    const normalizedDag = normalizeDagSpec(dagSpec || runMetadata.dagSpec || runMetadata.dag || {});
    if (normalizedDag.nodes.length) return `执行当前工作流（${normalizedDag.nodes.length} 个节点）`;
    return '';
}

function inferDagLlmRuntimeSettings(dagSpec = {}) {
    const nodes = Array.isArray(dagSpec?.nodes) ? dagSpec.nodes : [];
    const primaryLlmNodeId = String(dagSpec?.primaryLlmNodeId || dagSpec?.primary_llm_node_id || '').trim();
    const llmNode = nodes.find(node => node.id === primaryLlmNodeId && String(node?.tool || '').trim() === 'agent.llm')
        || nodes.find(node => String(node?.tool || '').trim() === 'agent.llm');
    const input = llmNode?.input && typeof llmNode.input === 'object' ? llmNode.input : {};
    const maxSteps = Number.parseInt(input.maxSteps ?? input.max_steps, 10);
    return {
        modelId: String(input.model || input.modelId || input.model_id || '').trim(),
        maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps : null
    };
}

module.exports = { inferDagRunGoal, inferDagLlmRuntimeSettings };
