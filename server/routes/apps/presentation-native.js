'use strict';

const documents = require('../../services/presentations/native/documents');
const jobs = require('../../services/presentations/native/jobs');
const runtime = require('../../services/presentations/master/runtime');

function registerPresentationNativeRoutes(router, { authMiddleware, asyncHandler, writeLog }) {
    const root = '/apps/presentations/native';
    const networkStatus = 'disabled';
    router.get(root + '/info', authMiddleware, asyncHandler(async (_req, res) => res.json({ engine: await runtime.availability(), videoMode: 'page_video', network: networkStatus })));
    router.get(root + '/documents', authMiddleware, asyncHandler(async (req, res) => res.json({ documents: await documents.list(req.user) })));
    router.get(root + '/documents/:id', authMiddleware, asyncHandler(async (req, res) => res.json({ document: documents.publicDocument(await documents.get(req.user, req.params.id)) })));
    router.get(root + '/documents/:id/versions', authMiddleware, asyncHandler(async (req, res) => res.json({ versions: await documents.versions(req.user, req.params.id) })));
    router.get(root + '/documents/:id/versions/:version', authMiddleware, asyncHandler(async (req, res) => res.json({ document: documents.publicDocument(await documents.get(req.user, req.params.id, Number(req.params.version))) })));
    router.get(root + '/documents/:id/versions/:version/preview/:slideIndex', authMiddleware, asyncHandler(async (req, res) => {
        const buffer = await documents.preview(req.user, req.params.id, Number(req.params.version), Number(req.params.slideIndex));
        res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).type('png').send(buffer);
    }));
    router.get(root + '/documents/:id/download', authMiddleware, asyncHandler(async (req, res) => {
        const loaded = await documents.download(req.user, req.params.id, req.query.version === undefined ? null : Number(req.query.version));
        writeLog(req, '下载原稿版本PPTX', `文稿: ${req.params.id}，版本: ${req.query.version || '当前'}`);
        res.set('Cache-Control', 'private, no-store').attachment(loaded.title.replace(/[\r\n\\/]/g, '_') + '.pptx').send(loaded.buffer);
    }));
    router.delete(root + '/documents/:id', authMiddleware, asyncHandler(async (req, res) => { await documents.remove(req.user, req.params.id); writeLog(req, '归档原稿编辑文稿', `文稿: ${req.params.id}`); res.json({ success: true }); }));
    router.post(root + '/jobs', authMiddleware, asyncHandler(async (req, res) => { const task = await jobs.start(req.user, req.body || {}); writeLog(req, '创建原稿离线任务', `任务: ${task.id}`); res.status(202).json({ task }); }));
    router.get(root + '/jobs/latest', authMiddleware, asyncHandler(async (req, res) => res.json({ task: await jobs.latest(req.user) })));
    router.get(root + '/jobs/:id', authMiddleware, asyncHandler(async (req, res) => {
        const task = await jobs.get(req.user, req.params.id);
        if (!task) return res.status(404).json({ error: '原稿任务不存在或无权访问。' });
        res.json({ task });
    }));
    router.post(root + '/jobs/:id/cancel', authMiddleware, asyncHandler(async (req, res) => res.json({ task: await jobs.cancel(req.user, req.params.id) })));
    router.post(root + '/jobs/:id/resume', authMiddleware, asyncHandler(async (req, res) => res.json({ task: await jobs.resume(req.user, req.params.id) })));
}
module.exports = { registerPresentationNativeRoutes };
