'use strict';

const tasks = require('../../services/presentations/master/tasks');
const runtime = require('../../services/presentations/master/runtime');
const { checkModel } = require('../../services/presentations/master/model-preflight');

function registerPresentationMasterRoutes(router, { authMiddleware, asyncHandler, writeLog }) {
    router.get('/apps/presentations/template-catalog', authMiddleware, asyncHandler(async (req, res) => res.json(await require('../../services/presentations/presentation-template-catalog').list(req.user))));
    router.get('/apps/presentations/master/info', authMiddleware, asyncHandler(async (_req, res) => {
        const available = await runtime.availability();
        res.json({ engine: { ...available, revision: available.revision || runtime.lock.revision, version: available.version || runtime.lock.skillVersion,
            operations: ['generate', 'create_template', 'edit_native'], profiles: ['default', 'quick', 'beautify', 'image_to_pptx'],
            editing: '保留原生PPTX和完整项目源包；复杂对象不自动转换为Pivot画布。' } });
    }));
    router.post('/apps/presentations/master/model-preflight', authMiddleware, asyncHandler(async (req, res) => {
        const available = await runtime.availability();
        if (!available.enabled || (available.transport === 'service' && !available.checklistReady)) {
            throw runtime.error(available.enabled ? '请更新独立PPT制作镜像以启用交付清单核验。' : available.message, 'PPT_MASTER_UNAVAILABLE', 503);
        }
        res.set('Cache-Control', 'no-store');
        res.json({ compatibility: await checkModel(req.user, req.body || {}, { visionRequired: req.body?.visionRequired === true }) });
    }));
    router.post('/apps/presentations/master/tasks', authMiddleware, asyncHandler(async (req, res) => {
        const task = await tasks.start(req.user, req.body || {});
        writeLog(req, '创建完整PPT制作任务', `任务: ${task.id}`); res.status(202).json({ task });
    }));
    router.get('/apps/presentations/master/tasks/latest', authMiddleware, asyncHandler(async (req, res) => res.json({ task: await tasks.latest(req.user, String(req.query.presentationId || '')) })));
    router.get('/apps/presentations/master/tasks/active', authMiddleware, asyncHandler(async (req, res) => res.json({ task: await tasks.activeTask(req.user) })));
    router.get('/apps/presentations/master/tasks/:taskId/review-draft', authMiddleware, asyncHandler(async (req, res) => {
        const draft = await tasks.readReviewDraft(req.user, req.params.taskId);
        writeLog(req, '下载待核验PPT草稿', `任务: ${req.params.taskId}`);
        res.set('Cache-Control', 'private, no-store').attachment(draft.filename).send(draft.buffer);
    }));
    router.get('/apps/presentations/master/tasks/:taskId', authMiddleware, asyncHandler(async (req, res) => {
        const task = await tasks.get(req.user, req.params.taskId);
        if (!task) return res.status(404).json({ error: '制作任务不存在或无权访问。' });
        res.json({ task });
    }));
    router.post('/apps/presentations/master/tasks/:taskId/respond', authMiddleware, asyncHandler(async (req, res) => res.json({ task: await tasks.respond(req.user, req.params.taskId, req.body) })));
    router.post('/apps/presentations/master/tasks/:taskId/resume', authMiddleware, asyncHandler(async (req, res) => res.json({ task: await tasks.resume(req.user, req.params.taskId, req.body || {}) })));
    router.post('/apps/presentations/master/tasks/:taskId/regenerate', authMiddleware, asyncHandler(async (req, res) => {
        const task = await tasks.regenerate(req.user, req.params.taskId);
        writeLog(req, '重新生成整份PPT', `任务: ${task.id}`);
        res.status(202).json({ task });
    }));
    router.post('/apps/presentations/master/tasks/:taskId/cancel', authMiddleware, asyncHandler(async (req, res) => {
        const task = await tasks.cancel(req.user, req.params.taskId);
        if (!task) return res.status(404).json({ error: '制作任务不存在或无权访问。' });
        res.json({ task });
    }));
}
module.exports = { registerPresentationMasterRoutes };
