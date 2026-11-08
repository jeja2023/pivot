'use strict';

const actions = require('../../services/presentations/presentation-design-actions');
const qualityTasks = require('../../services/presentations/presentation-quality-tasks');

function registerPresentationDesignRoutes(router, { authMiddleware, asyncHandler, writeLog }) {
    router.get('/apps/presentations/design/info', authMiddleware, asyncHandler(async (req, res) => res.json(await actions.designInfo(req.user))));
    router.post('/apps/presentations/:id/design-tasks', authMiddleware, asyncHandler(async (req, res) => {
        const { mode = 'visual', model = '' } = req.body || {};
        if (!['visual', 'layout', 'visual_repair', 'production'].includes(mode) || typeof model !== 'string' || model.length > 160) return res.status(400).json({ error: '请选择有效的检查方式和模型。' });
        const task = await qualityTasks.createQualityTask(req.user, { presentationId: req.params.id, mode, modelId: model });
        writeLog(req, '创建PPT整稿检查', `文稿: ${req.params.id}，任务: ${task.id}，方式: ${mode}`);
        res.status(202).json({ task });
    }));
    router.get('/apps/presentations/:id/design-tasks/latest', authMiddleware, asyncHandler(async (req, res) => res.json({ task: await qualityTasks.getQualityTask(req.user, req.params.id) })));
    router.get('/apps/presentations/:id/design-tasks/:taskId', authMiddleware, asyncHandler(async (req, res) => {
        const task = await qualityTasks.getQualityTask(req.user, req.params.id, req.params.taskId);
        if (!task) return res.status(404).json({ error: '检查任务不存在或已无权访问。' });
        res.json({ task });
    }));
    router.post('/apps/presentations/:id/design-tasks/:taskId/cancel', authMiddleware, asyncHandler(async (req, res) => {
        const task = await qualityTasks.cancelQualityTask(req.user, req.params.id, req.params.taskId);
        if (!task) return res.status(404).json({ error: '检查任务不存在或已无权访问。' });
        res.json({ task });
    }));
    router.post('/apps/presentations/:id/visual-review', authMiddleware, asyncHandler(async (req, res) => {
        const { slideIndex, model } = req.body || {};
        if (!Number.isInteger(slideIndex) || slideIndex < 0 || (model !== undefined && (typeof model !== 'string' || model.length > 160))) return res.status(400).json({ error: '请选择有效页码和模型。' });
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        req.once('aborted', onAbort);
        res.once('close', () => { if (!res.writableEnded) onAbort(); });
        try {
            const review = await actions.review(req.user, { presentationId: req.params.id, slideIndex, modelId: model }, { signal: controller.signal });
            writeLog(req, 'PPT视觉复核', `文稿: ${req.params.id}，页码: ${slideIndex + 1}，状态: ${review.status}`);
            res.json({ review });
        } finally { req.removeListener('aborted', onAbort); }
    }));
}

module.exports = { registerPresentationDesignRoutes };
