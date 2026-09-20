'use strict';

const { asyncHandler } = require('../http');
const { formatToolList } = require('../services/agent-tool-catalog');
const { executeToolByName, findAgentToolByName } = require('../services/agent-tool-runtime');
const { PolicyError } = require('../services/agent-policy');
const { resolveDagNodeInput } = require('../services/agent-dag-utils');

function registerAgentToolTestRoute({ router, authMiddleware, logAction }) {
    router.post('/agents/tools/test', authMiddleware, asyncHandler(async (req, res) => {
        const toolName = String(req.body?.tool || '').trim();
        const input = req.body?.input && typeof req.body.input === 'object' && !Array.isArray(req.body.input) ? req.body.input : {};
        const tools = await formatToolList(req.user); const tool = findAgentToolByName(toolName, tools);
        if (!tool) return res.status(403).json({ error: '工具不可用或无权访问。' });
        if (['workflow.approval', 'workflow.delay', 'workflow.subworkflow'].includes(toolName)) return res.status(400).json({ error: '人工审批、延时和子工作流节点需要在完整工作流中测试。' });
        const discovery = /(?:^|\.)im\.list_allowed_targets$/.test(toolName);
        if (!discovery && (tool.side_effect === true || tool.sideEffect === true || tool.requiresApproval === true || tool.alwaysRequiresApproval === true)) return res.status(400).json({ error: '为避免产生真实副作用，此节点不能单独测试；请使用完整工作流并按审批策略运行。' });
        let resolvedInput = input; const rawContext = req.body?.upstreamContext;
        if (rawContext && typeof rawContext === 'object') {
            const states = new Map(Array.isArray(rawContext.states) ? rawContext.states : (rawContext.states && typeof rawContext.states === 'object' ? Object.entries(rawContext.states) : []));
            const nodeMap = new Map(Array.isArray(rawContext.nodes) ? rawContext.nodes.map(node => [node.id, node]) : (rawContext.nodes && typeof rawContext.nodes === 'object' ? Object.entries(rawContext.nodes) : []));
            const dagInputs = req.body?.dagInputs && typeof req.body.dagInputs === 'object' ? req.body.dagInputs : (rawContext.inputs || {});
            resolvedInput = resolveDagNodeInput({ tool: toolName, input }, { goal: String(rawContext.goal || req.body?.dagInputs?.goal || '').trim(), inputs: dagInputs, states, nodeMap });
        }
        const startedAt = Date.now(); let output;
        try { output = await executeToolByName(toolName, resolvedInput, req.user, tools, { dagInputs: req.body?.dagInputs && typeof req.body.dagInputs === 'object' ? req.body.dagInputs : {} }); }
        catch (error) {
            if (error instanceof PolicyError || [400, 403, 404].includes(error?.status)) return res.status(error.status || 400).json({ error: error.message });
            throw error;
        }
        logAction(req, '测试智能体工具节点', `工具: ${toolName}`);
        res.json({ success: true, output, resolvedInput, durationMs: Date.now() - startedAt });
    }));
}

module.exports = { registerAgentToolTestRoute };
