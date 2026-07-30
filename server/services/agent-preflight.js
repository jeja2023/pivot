const { db } = require('../db');
const { getRunnableModelForUser } = require('./models');
const { formatToolList } = require('./agent-tool-catalog');
const { assertWorkflowHasConfiguredLlm, resolveAgentWorkflowVersion } = require('./agent-workflows');
const { isSuperAdmin } = require('../permissions');
const { inspectDagContracts } = require('./agent-dag-contracts');
const {
    normalizeApprovalPolicy,
    normalizeDagSpec,
    normalizeMaxSteps,
    normalizePositiveInt,
    normalizeRunMode,
    normalizeToolAllowlist,
    normalizeToolPolicy
} = require('./agent-validators');

function estimatePromptTokens(text) {
    return Math.max(1, Math.ceil(String(text || '').length / 2));
}

function clampReadinessScore(value) {
    const score = Math.round(Number(value) || 0);
    return Math.max(0, Math.min(score, 100));
}

function getMcpHealthForPreflight(user) {
    const superAdmin = isSuperAdmin(user);
    const scope = superAdmin ? "status != 'deleted'" : "status != 'deleted' AND (user_id IS NULL OR user_id = ?)";
    const params = superAdmin ? [] : [user.id];
    return db.prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN last_error IS NOT NULL AND last_error != '' THEN 1 ELSE 0 END) AS error,
            SUM(CASE WHEN last_checked_at IS NULL OR last_checked_at = '' THEN 1 ELSE 0 END) AS unchecked
        FROM mcp_servers
        WHERE ${scope}
    `).get(...params);
}

function inferDagLlmModelId(dag = {}) {
    const nodes = Array.isArray(dag?.nodes) ? dag.nodes : [];
    const primaryLlmNodeId = String(dag?.primaryLlmNodeId || dag?.primary_llm_node_id || '').trim();
    const llmNode = nodes.find(node => node.id === primaryLlmNodeId && String(node?.tool || '').trim() === 'agent.llm')
        || nodes.find(node => String(node?.tool || '').trim() === 'agent.llm');
    const input = llmNode?.input && typeof llmNode.input === 'object' ? llmNode.input : {};
    return String(input.model || input.modelId || input.model_id || '').trim();
}

function preflightAgentRun(user, body = {}) {
    const goal = String(body.goal || '').trim();
    const toolPolicy = normalizeToolPolicy(body.toolPolicy || body.tool_policy);
    const toolAllowlist = normalizeToolAllowlist(body.toolAllowlist || body.tool_allowlist);
    const runMode = normalizeRunMode(body.runMode || body.run_mode);
    const approvalPolicy = normalizeApprovalPolicy(body.approvalPolicy || body.approval_policy);
    const maxSteps = normalizeMaxSteps(body.maxSteps || body.max_steps);
    const maxTokenBudget = normalizePositiveInt(body.maxTokenBudget || body.max_token_budget, 0, 0, 10000000);
    const toolList = formatToolList(user, { toolPolicy, toolAllowlist });
    const mcpTools = toolList.filter(tool => tool.source === 'mcp');
    const highRiskTools = mcpTools.filter(tool => tool.requiresApproval || tool.risk === 'high');
    const mcpHealth = getMcpHealthForPreflight(user) || {};
    const estimatedInputTokens = estimatePromptTokens(goal) + Math.min(Number(body.contextPreviewTokens || body.context_preview_tokens || 0), 20000);
    const knowledge = db.prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'ready' AND COALESCE(is_enabled, 1) = 1 THEN 1 ELSE 0 END) AS ready,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error,
            COALESCE(SUM(chunk_count), 0) AS chunks
        FROM knowledge_docs
        WHERE user_id = ? AND deleted_at IS NULL
    `).get(user.id);
    const warnings = [];
    const blockers = [];
    let dag = null;
    let contractReport = null;
    if (mcpTools.length > 0 && Number(mcpHealth.error || 0) > 0) warnings.push('工具箱存在异常服务，本次任务可能遇到工具调用失败。');
    if (mcpTools.length > 0 && Number(mcpHealth.unchecked || 0) > 0) warnings.push('工具箱存在未刷新工具列表的服务，建议先刷新工具缓存。');
    if (runMode === 'dag') {
        const workflowId = body.workflowId || body.workflow_id;
        if (workflowId) {
            try {
                dag = resolveAgentWorkflowVersion(workflowId, user, body.workflowVersion || body.workflow_version || 'current')?.dagSpec;
            } catch (e) {
                blockers.push(e.message || 'Workflow version is not available.');
            }
        }
        dag = dag || normalizeDagSpec(body.dagSpec || body.dag_spec || {});
    }
    const effectiveModelId = body.modelId || body.model_id || (runMode === 'dag' ? inferDagLlmModelId(dag) : '');
    const modelCfg = getRunnableModelForUser(effectiveModelId, user);
    if (goal.length < 4) blockers.push('任务目标过短，智能体无法稳定规划。');
    if (!modelCfg) blockers.push('未选择可用模型。');
    if (toolList.length === 0) blockers.push('当前工具范围内没有可用能力。');
    if (toolPolicy === 'builtin_only' && /mcp|数据库|外部|接口|工具/i.test(goal)) warnings.push('目标可能需要 MCP，但当前设置为仅内置工具。');
    if (mcpTools.length > 0 && approvalPolicy === 'approve_all_mcp') warnings.push('所有工具箱工具调用都会进入人工审批，长任务可能暂停等待。');
    if (highRiskTools.length > 0 && approvalPolicy === 'safe_mcp_auto') warnings.push('高风险工具箱工具会在执行前等待人工审批。');
    if (Number(knowledge.ready || 0) === 0 && /知识库|资料|文档|依据|引用/i.test(goal)) warnings.push('目标提到了资料或知识库，但当前没有启用且就绪的知识库文档。');
    if (Number(knowledge.error || 0) > 0) warnings.push('知识库存在索引失败文档，可能影响召回完整性。');
    if (runMode === 'dag') {
        if (!dag.nodes.length) blockers.push('工作流编排模式需要至少一个有效节点。');
        if (dag.nodes.length) {
            try {
                assertWorkflowHasConfiguredLlm(dag);
            } catch (e) {
                blockers.push(e.message || '工作流大模型节点配置不完整。');
            }
            contractReport = inspectDagContracts(dag, toolList);
            blockers.push(...contractReport.blockers);
            warnings.push(...contractReport.warnings);
        }
    }
    if (maxSteps < 3 && runMode !== 'dag') warnings.push('步骤数较少，复杂任务可能来不及完成检索、分析和总结。');
    if (maxTokenBudget > 0 && maxTokenBudget < 2000) warnings.push('Token 预算偏低，可能导致任务提前停止。');
    if (maxTokenBudget > 0 && estimatedInputTokens > maxTokenBudget) warnings.push('预估输入 Token 已超过预算，建议提高预算或缩小任务范围。');
    const status = blockers.length ? 'blocked' : (warnings.length ? 'warning' : 'ready');
    let readinessScore = 100;
    readinessScore -= blockers.length * 35;
    readinessScore -= warnings.length * 8;
    readinessScore -= Math.min(Number(mcpHealth.error || 0) * 8, 24);
    readinessScore -= Math.min(Number(knowledge.error || 0) * 6, 18);
    if (maxTokenBudget > 0 && estimatedInputTokens > maxTokenBudget) readinessScore -= 15;
    readinessScore = clampReadinessScore(readinessScore);
    return {
        status,
        blockers,
        warnings,
        summary: {
            model: modelCfg ? { id: modelCfg.id, name: modelCfg.name, model_name: modelCfg.model_name } : null,
            runMode,
            approvalPolicy,
            maxSteps,
            maxTokenBudget,
            toolCount: toolList.length,
            mcpToolCount: mcpTools.length,
            highRiskToolCount: highRiskTools.length,
            approvalWaitRisk: highRiskTools.length > 0 && approvalPolicy !== 'approve_all_mcp' ? 'high_risk_only' : (approvalPolicy === 'approve_all_mcp' ? 'all_mcp' : 'none'),
            estimatedInputTokens,
            readinessScore,
            mcpServers: Number(mcpHealth.total || 0),
            mcpActiveServers: Number(mcpHealth.active || 0),
            mcpErrorServers: Number(mcpHealth.error || 0),
            mcpUncheckedServers: Number(mcpHealth.unchecked || 0),
            knowledgeReady: Number(knowledge.ready || 0),
            knowledgeChunks: Number(knowledge.chunks || 0),
            knowledgeErrors: Number(knowledge.error || 0)
        },
        contracts: contractReport,
        recommendations: blockers.length
            ? ['修复阻断项后再创建任务。']
            : warnings.length
                ? ['可继续运行，但建议根据风险调整工具范围、审批策略或知识库状态。']
                : ['预检通过，当前配置适合创建任务。']
    };
}

module.exports = {
    preflightAgentRun
};
