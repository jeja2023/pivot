'use strict';

const { asyncHandler } = require('../http');
const { getChatTaskFeed } = require('../services/chat-task-feed');

function registerChatTaskFeedRoutes(router, { authMiddleware, pauseAgentRun, refreshAgentToolApproval, logAction } = {}) {
    router.get('/agents/runs/:id/chat-feed', authMiddleware, asyncHandler(async (req, res) => {
        const feed = await getChatTaskFeed(req.params.id, req.user, req.query);
        if (!feed) return res.status(404).json({ error: '任务不存在或当前账号无权查看。', code: 'CHAT_TASK_NOT_FOUND' });
        res.setHeader('Cache-Control', 'no-store');
        res.json(feed);
    }));
    router.post('/agents/runs/:id/pause', authMiddleware, asyncHandler(async (req, res) => {
        const run = await pauseAgentRun(req.params.id, req.user);
        if (!run) return res.status(404).json({ error: '任务不存在或当前账号无权操作。' });
        logAction?.(req, '暂停对话任务', `任务ID: ${run.id}`);
        res.json({ success: true, run });
    }));
    router.post('/agents/runs/:id/approval/refresh', authMiddleware, asyncHandler(async (req, res) => {
        if (typeof req.body?.inputHash !== 'string' || !req.body.inputHash) return res.status(400).json({ error: '缺少当前授权请求标识，请刷新任务状态。' });
        const run = await refreshAgentToolApproval(req.params.id, req.user, {
            inputHash: req.body.inputHash, key: req.body.key, requestedAt: req.body.requestedAt
        });
        if (!run) return res.status(404).json({ error: '任务不存在或当前账号无权操作。' });
        logAction?.(req, '刷新对话任务授权请求', `任务ID: ${run.id}`);
        res.json({ success: true, run });
    }));
}

module.exports = { registerChatTaskFeedRoutes };
