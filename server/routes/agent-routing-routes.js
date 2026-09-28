'use strict';

const { asyncHandler } = require('../http');
const { formatToolList } = require('../services/agent-tool-catalog');
const { recommendPublishedWorkflow } = require('../services/decision-workflow-recommender');

function registerAgentRoutingRoutes(router, dependencies = {}) {
    const { authMiddleware, automationGuard, logAction } = dependencies;

    router.get('/agents/tools', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ tools: await formatToolList(req.user) });
    }));

    router.post('/agents/workflow-recommendations', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const prompt = String(req.body?.prompt || req.body?.goal || '').trim().slice(0, 4000);
        if (!prompt) return res.status(400).json({ error: '请提供需要推荐工作流的任务描述。' });
        const recommendation = await recommendPublishedWorkflow({
            user: req.user,
            prompt,
            sessionId: String(req.body?.sessionId || '').trim().slice(0, 128),
            maxCandidates: req.body?.maxCandidates
        });
        logAction(req, '推荐业务工作流', recommendation.selectedWorkflow ? '推荐工作流: ' + recommendation.selectedWorkflow.id : '建议不启动工作流');
        // 只返回建议；启动工作流仍必须由既有发布、权限、审批和运行入口处理。
        res.json(recommendation);
    }));
}

module.exports = { registerAgentRoutingRoutes };
