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

module.exports = { inferDagRunGoal };
