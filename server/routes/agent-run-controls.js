'use strict';

const { asyncHandler } = require('../http');

function registerAgentRunControlRoutes(router, { authMiddleware, automationGuard, logAction,
    cancelAgentRun, approveAgentTool, revokeApprovedAgentTool, resumeAgentRun, listSteps }) {
    router.post('/agents/runs/:id/cancel', authMiddleware, asyncHandler(async (req, res) => {
        const run = await cancelAgentRun(req.params.id, req.user);
        if (!run) return res.status(404).json({ error: '智能体任务不存在或不可取消。' });
        logAction(req, '取消智能体任务', `任务ID: ${run.id}`);
        res.json({ success: true, run });
    }));

    router.post('/agents/runs/:id/approval', authMiddleware, asyncHandler(async (req, res) => {
        const binding = req.body?.inputHash === undefined ? null : {
            inputHash: req.body.inputHash,
            key: req.body.key,
            requestedAt: req.body.requestedAt,
            rememberForRun: req.body?.rememberForRun === true || req.body?.remember_for_run === true
        };
        const run = await approveAgentTool(req.params.id, req.user, req.body?.approve !== false, binding);
        if (!run) return res.status(404).json({ error: '智能体任务不存在。' });
        logAction(req, req.body?.approve === false ? '拒绝智能体工具审批' : '批准智能体工具审批', `任务ID: ${run.id}${binding?.rememberForRun ? ' (本次运行免密放行)' : ''}`);
        res.json({ success: true, run, steps: await listSteps(run.id) });
    }));

    router.post('/agents/runs/:id/approval/revoke', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const run = await revokeApprovedAgentTool(req.params.id, req.user, req.body?.approvalKey || req.body?.approval_key);
        if (!run) return res.status(404).json({ error: '智能体任务不存在。' });
        logAction(req, '撤销尚未执行的智能体工具审批', `任务ID: ${run.id}`);
        res.json({ success: true, run, steps: await listSteps(run.id) });
    }));

    router.post('/agents/runs/:id/resume', authMiddleware, asyncHandler(async (req, res) => {
        const run = await resumeAgentRun(req.params.id, req.user);
        if (!run) return res.status(404).json({ error: '智能体任务不存在。' });
        logAction(req, '断点续跑智能体任务', `任务ID: ${run.id}，来源任务ID: ${req.params.id}`);
        res.status(202).json({ success: true, run });
    }));
}

module.exports = { registerAgentRunControlRoutes };
