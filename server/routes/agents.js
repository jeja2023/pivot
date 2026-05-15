const express = require('express');
const { asyncHandler, normalizeLimit } = require('../http');
const {
    cancelAgentRun,
    createAgentRun,
    formatToolList,
    getRunDetailForUser,
    listDeletedRunsForAdmin,
    listRuns,
    listSteps,
    rerunAgentRun,
    softDeleteAgentRun
} = require('../services/agent-runtime');

function createAgentsRouter({ authMiddleware, logAction }) {
    const router = express.Router();

    router.get('/agents/tools', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ tools: formatToolList(req.user) });
    }));

    router.get('/agents/runs', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: listRuns(req.user, normalizeLimit(req.query.limit, 30, 100)) });
    }));

    router.get('/agents/runs/deleted/audit', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: listDeletedRunsForAdmin(req.user, normalizeLimit(req.query.limit, 100, 200)) });
    }));

    router.post('/agents/runs', authMiddleware, asyncHandler(async (req, res) => {
        const run = createAgentRun({
            user: req.user,
            goal: req.body?.goal,
            modelId: req.body?.modelId,
            sessionId: req.body?.sessionId,
            title: req.body?.title,
            maxSteps: req.body?.maxSteps
        });
        logAction(req, '创建自动化任务', `任务ID: ${run.id}，目标: ${String(req.body?.goal || '').slice(0, 120)}`);
        res.status(202).json({ success: true, run });
    }));

    router.get('/agents/runs/:id', authMiddleware, asyncHandler(async (req, res) => {
        const detail = getRunDetailForUser(req.params.id, req.user);
        if (!detail) return res.status(404).json({ error: '自动化任务不存在。' });
        res.json(detail);
    }));

    router.post('/agents/runs/:id/cancel', authMiddleware, asyncHandler(async (req, res) => {
        const run = cancelAgentRun(req.params.id, req.user);
        if (!run) return res.status(404).json({ error: '自动化任务不存在。' });
        logAction(req, '停止自动化任务', `任务ID: ${run.id}`);
        res.json({ success: true, run, steps: listSteps(run.id) });
    }));

    router.post('/agents/runs/:id/rerun', authMiddleware, asyncHandler(async (req, res) => {
        const run = rerunAgentRun(req.params.id, req.user);
        if (!run) return res.status(404).json({ error: '自动化任务不存在。' });
        logAction(req, '重新运行自动化任务', `任务ID: ${run.id}，来源任务ID: ${req.params.id}`);
        res.status(202).json({ success: true, run });
    }));

    router.delete('/agents/runs/:id', authMiddleware, asyncHandler(async (req, res) => {
        const run = softDeleteAgentRun(req.params.id, req.user, req.body?.reason || '');
        if (!run) return res.status(404).json({ error: '自动化任务记录不存在。' });
        logAction(req, '移除自动化任务记录', `任务ID: ${run.id}，目标: ${String(run.goal || '').slice(0, 120)}`);
        res.json({ success: true, run });
    }));

    return router;
}

module.exports = { createAgentsRouter };
