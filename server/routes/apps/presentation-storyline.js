'use strict';

const tasks = require('../../services/presentations/storyline/tasks');
function registerPresentationStorylineRoutes(router, { authMiddleware, asyncHandler, writeLog }) {
    const root = '/apps/presentations/:id/storyline-tasks';
    router.post(root, authMiddleware, asyncHandler(async (req, res) => { const task = await tasks.start(req.user, req.params.id, req.body || {}); writeLog(req, '生成PPT故事线调整方案', `文稿: ${req.params.id}，任务: ${task.id}`); res.status(202).json({ task }); }));
    router.get(root + '/latest', authMiddleware, asyncHandler(async (req, res) => res.json({ task: await tasks.get(req.user, req.params.id) })));
    router.get(root + '/:taskId', authMiddleware, asyncHandler(async (req, res) => res.json({ task: await tasks.get(req.user, req.params.id, req.params.taskId) })));
    router.post(root + '/:taskId/cancel', authMiddleware, asyncHandler(async (req, res) => res.json({ task: await tasks.cancel(req.user, req.params.id, req.params.taskId) })));
    router.post(root + '/:taskId/apply', authMiddleware, asyncHandler(async (req, res) => { const result = await tasks.apply(req.user, req.params.id, req.params.taskId, req.body || {}); writeLog(req, '确认PPT故事线调整', `文稿: ${req.params.id}，版本: ${result.appliedVersion}`); res.json(result); }));
}
module.exports = { registerPresentationStorylineRoutes };
