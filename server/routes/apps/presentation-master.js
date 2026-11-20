'use strict';

const tasks = require('../../services/presentations/master/tasks');
const runtime = require('../../services/presentations/master/runtime');
const { checkModel } = require('../../services/presentations/master/model-preflight');

function registerPresentationMasterRoutes(router, { authMiddleware, asyncHandler, writeLog }) {
    router.get('/apps/presentations/template-catalog', authMiddleware, asyncHandler(async (req, res) => res.json(await require('../../services/presentations/presentation-template-catalog').list(req.user))));
    router.get('/apps/presentations/template-catalog/:id/preview', authMiddleware, asyncHandler(async (req, res) => {
        const preview = await require('../../services/presentations/presentation-catalog-preview').preview(req.user, req.params.id, req.query);
        res.set('Cache-Control', 'private, no-store').type(preview.mimeType).send(preview.buffer);
    }));
    router.get('/apps/presentations/master/info', authMiddleware, asyncHandler(async (_req, res) => {
        const available = await runtime.availability();
        res.json({ engine: { ...available, revision: available.revision || runtime.lock.revision, version: available.version || runtime.lock.skillVersion,
            operations: ['generate', 'create_template', 'edit_native'], profiles: ['default', 'quick', 'beautify', 'image_to_pptx'],
            editing: '保留原生PPTX和完整项目源包；复杂对象不自动转换为Pivot画布。' } });
    }));
    router.post('/apps/presentations/master/model-preflight', authMiddleware, asyncHandler(async (req, res) => {
        const available = await runtime.availability();
        runtime.requireReady(available, req.body?.operation || 'generate');
        res.set('Cache-Control', 'no-store');
        res.json({ compatibility: await checkModel(req.user, req.body || {}, { visionRequired: req.body?.visionRequired === true }) });
    }));
    router.post('/apps/presentations/master/tasks', authMiddleware, asyncHandler(async (req, res) => {
        const task = await tasks.start(req.user, req.body || {});
        writeLog(req, '创建完整PPT制作任务', `任务: ${task.id}`); res.status(202).json({ task });
    }));
    router.get('/apps/presentations/master/tasks/latest', authMiddleware, asyncHandler(async (req, res) => res.json({ task: await tasks.latest(req.user, String(req.query.presentationId || '')) })));
    router.get('/apps/presentations/master/tasks/recent', authMiddleware, asyncHandler(async (req, res) => {
        res.set('Cache-Control', 'private, no-store').json({ tasks: await tasks.recent(req.user) });
    }));
    router.get('/apps/presentations/master/tasks/active', authMiddleware, asyncHandler(async (req, res) => res.json({ task: await tasks.activeTask(req.user) })));
    router.get('/apps/presentations/master/tasks/:taskId/review-draft', authMiddleware, asyncHandler(async (req, res) => {
        const draft = await tasks.readReviewDraft(req.user, req.params.taskId);
        writeLog(req, '下载待核验PPT草稿', `任务: ${req.params.taskId}`);
        res.set('Cache-Control', 'private, no-store').attachment(draft.filename).send(draft.buffer);
    }));
    router.post('/apps/presentations/master/tasks/:taskId/review-pages', authMiddleware, asyncHandler(async (req, res) => {
        const preview = await tasks.inspectPages(req.user, req.params.taskId);
        res.set('Cache-Control', 'private, no-store').json(preview);
    }));
    router.get('/apps/presentations/master/tasks/:taskId/snapshots/:kind', authMiddleware, asyncHandler(async (req, res) => {
        const file = await tasks.readSnapshot(req.user, req.params.taskId, req.params.kind);
        writeLog(req, '读取PPT制作快照', `任务: ${req.params.taskId}，类型: ${req.params.kind}`);
        res.set('Cache-Control', 'private, no-store').attachment(file.filename).type(file.mimeType).send(file.buffer);
    }));
    router.get('/apps/presentations/master/tasks/:taskId/review-pages', authMiddleware, asyncHandler(async (req, res) => {
        const preview = await tasks.readSavedPages(req.user, req.params.taskId);
        res.set('Cache-Control', 'private, no-store').json(preview);
    }));
    router.post('/apps/presentations/master/tasks/:taskId/review-pages/save', authMiddleware, asyncHandler(async (req, res) => {
        const preview = await tasks.saveReviewPages(req.user, req.params.taskId, req.body?.exportRevision);
        writeLog(req, '保存已通过的PPT页面', `任务: ${req.params.taskId}`);
        res.set('Cache-Control', 'private, no-store').json(preview);
    }));
    router.get('/apps/presentations/master/tasks/:taskId/review-pages/:file', authMiddleware, asyncHandler(async (req, res) => {
        const image = await tasks.readPagePreview(req.user, req.params.taskId, req.params.file);
        res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).type('png').send(image);
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
