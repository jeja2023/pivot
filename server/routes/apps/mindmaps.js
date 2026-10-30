'use strict';
const { asyncHandler } = require('../../http');
const service = require('../../services/mindmaps/documents');
const schema = require('../../../client/common/mindmap-document');
const exportsService = require('../../services/mindmaps/exports');
function registerMindmapRoutes(router, { authMiddleware, logAction = () => {} }) {
    const store = require('../../services/rate-limit-store').createRateLimitStore;
    const limiter = require('express-rate-limit')({ store: store('mindmaps:api'), windowMs: 60000, limit: 100, keyGenerator: req => String(req.user.id), message: { error: '导图操作过于频繁，请稍后重试。' } });
    const aiLimiter = require('express-rate-limit')({ store: store('mindmaps:ai'), windowMs: 60000, limit: 6, keyGenerator: req => String(req.user.id), message: { error: 'AI 生成过于频繁，请稍后重试。' } });
    const syncLimiter = require('express-rate-limit')({ store: store('mindmaps:sync'), windowMs: 60000, limit: 240, keyGenerator: req => String(req.user.id), message: { error: '协作同步请求过于频繁，请关闭多余窗口。' } });
    router.get('/apps/mindmaps/:id/sync', authMiddleware, syncLimiter, asyncHandler(async (req, res) => {
        const document = await service.get(req.user, req.params.id);
        if (document.versionId === String(req.query.versionId) && document.collaborationEpoch === String(req.query.epoch)) return res.json({ success: true, unchanged: true, role: document.role, collaboration: document.collaboration });
        res.json({ success: true, ...document });
    }));
    router.use('/apps/mindmaps', authMiddleware, limiter);
    router.post('/apps/mindmaps/:id/stream-ticket', asyncHandler(async (req, res) => res.json({ success: true, ...await require('../../services/mindmaps/realtime').mindmapRealtime.issueTicket(req.user, service.id(req.params.id)) })));
    router.get('/apps/mindmaps/share-targets', asyncHandler(async (req, res) => res.json({ success: true, ...await require('../../services/mindmaps/product').shareTargets(req.user) })));
    router.get('/apps/mindmaps/themes', asyncHandler(async (req, res) => res.json({ success: true, rows: await require('../../services/mindmaps/product').themes(req.user) })));
    router.post('/apps/mindmaps/themes', asyncHandler(async (req, res) => res.json({ success: true, theme: await require('../../services/mindmaps/product').saveTheme(req.user, req.body?.theme) })));
    router.delete('/apps/mindmaps/themes/:themeId', asyncHandler(async (req, res) => { await require('../../services/mindmaps/product').removeTheme(req.user, req.params.themeId); res.json({ success: true }); }));
    router.get('/apps/mindmaps/personal-templates', asyncHandler(async (req, res) => res.json({ success: true, rows: await require('../../services/mindmaps/product').templates(req.user) })));
    router.post('/apps/mindmaps/personal-templates', asyncHandler(async (req, res) => res.status(201).json({ success: true, template: await require('../../services/mindmaps/product').saveTemplate(req.user, req.body) })));
    router.get('/apps/mindmaps/personal-templates/:templateId', asyncHandler(async (req, res) => res.json({ success: true, document: await require('../../services/mindmaps/product').template(req.user, req.params.templateId) })));
    router.delete('/apps/mindmaps/personal-templates/:templateId', asyncHandler(async (req, res) => { await require('../../services/mindmaps/product').removeTemplate(req.user, req.params.templateId); res.json({ success: true }); }));
    router.get('/apps/mindmaps', asyncHandler(async (req, res) => res.json({ success: true, ...await service.list(req.user, req.query) })));
    router.post('/apps/mindmaps', asyncHandler(async (req, res) => {
        const result = await service.save(req.user, req.body || {}, { legacy: !req.body?.document });
        logAction(req, '保存思维导图', `产物ID: ${result.id}`);
        res.status(201).json({ success: true, ...result, artifactId: result.id, mindmapArtifactId: result.id, tree: result.document.tree });
    }));
    router.post('/apps/mindmaps/import', asyncHandler(async (req, res) => res.json({ success: true, document: await service.importDocument(req.body) })));
    router.post('/apps/mindmaps/templates', asyncHandler(async (req, res) => res.json({ success: true, document: service.template(req.body?.template, req.body?.title) })));
    router.post('/apps/mindmaps/preview', asyncHandler(async (req, res) => {
        const document = schema.normalize(req.body?.document || req.body?.tree);
        const svg = require('../../services/mindmap').mindmapSvg(document.tree, document.presentation.themeId);
        res.json({ success: true, svg });
    }));
    router.post('/apps/mindmaps/ai', aiLimiter, asyncHandler(async (req, res) => {
        const prepared = await require('../../services/mindmaps/ai').prepare(req.user, req.body);
        return require('./helpers').runAppsAiCompletion({ req, res, logAction, source: 'apps.mindmaps', auditAction: 'AI 生成思维导图', maxTokens: 4000, messages: prepared.messages, transformCompletion: prepared.transform });
    }));
    router.get('/apps/mindmaps/data-views', asyncHandler(async (req, res) => res.json({ success: true, rows: await require('../../services/mindmaps/data-source').views(req.user) })));
    router.get('/apps/mindmaps/data-sources', asyncHandler(async (req, res) => res.json({ success: true, rows: await require('../../services/mindmaps/data-source').datasets(req.user) })));
    router.post('/apps/mindmaps/from-dataset', asyncHandler(async (req, res) => res.json({ success: true, document: await require('../../services/mindmaps/data-source').fromDataset(req.user, req.body) })));
    router.post('/apps/mindmaps/from-data', asyncHandler(async (req, res) => res.json({ success: true, document: await require('../../services/mindmaps/data-source').preview(req.user, req.body?.viewId) })));
    router.get('/apps/mindmaps/exports/:jobId', asyncHandler(async (req, res) => res.json({ success: true, job: await exportsService.get(req.user, req.params.jobId) })));
    router.get('/apps/mindmaps/:id', asyncHandler(async (req, res) => res.json({ success: true, ...await service.get(req.user, req.params.id) })));
    router.get('/apps/mindmaps/:id/thumbnail', asyncHandler(async (req, res) => { const buffer = await require('../../services/mindmaps/previews').get(req.user, req.params.id); res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).type('png').send(buffer); }));
    router.post('/apps/mindmaps/:id/refresh-source', asyncHandler(async (req, res) => res.json({ success: true, ...await require('../../services/mindmaps/data-source').refresh(req.user, req.params.id, req.body) })));
    router.get('/apps/mindmaps/:id/sharing', asyncHandler(async (req, res) => res.json({ success: true, ...await require('../../services/mindmaps/product').sharing(req.user, req.params.id) })));
    router.put('/apps/mindmaps/:id/sharing', asyncHandler(async (req, res) => {
        const sharing = await require('../../services/mindmaps/product').setSharing(req.user, req.params.id, req.body);
        logAction(req, '更新导图共享权限', `产物ID: ${req.params.id}，账号数: ${sharing.members.length}`); res.json({ success: true, ...sharing });
    }));
    router.put('/apps/mindmaps/:id/settings', asyncHandler(async (req, res) => res.json({ success: true, ...await require('../../services/mindmaps/product').settings(req.user, req.params.id, req.body) })));
    router.post('/apps/mindmaps/:id/recover', asyncHandler(async (req, res) => { const document = await require('../../services/mindmaps/product').recover(req.user, req.params.id); logAction(req, '从回收站恢复导图', `产物ID: ${document.id}`); res.json({ success: true, ...document }); }));
    router.put('/apps/mindmaps/:id', asyncHandler(async (req, res) => res.json({ success: true, ...await service.save(req.user, { ...req.body, artifactId: req.params.id }) })));
    router.delete('/apps/mindmaps/:id', asyncHandler(async (req, res) => {
        await service.remove(req.user, req.params.id, req.body?.expectedVersionId);
        logAction(req, '删除思维导图', `产物ID: ${req.params.id}`); res.json({ success: true });
    }));
    router.get('/apps/mindmaps/:id/versions', asyncHandler(async (req, res) => res.json({ success: true, ...await service.versions(req.user, req.params.id, req.query) })));
    router.get('/apps/mindmaps/:id/versions/:versionId', asyncHandler(async (req, res) => res.json({ success: true, ...await service.snapshot(req.user, req.params.id, req.params.versionId) })));
    router.post('/apps/mindmaps/:id/versions/:versionId/restore', asyncHandler(async (req, res) => res.json({ success: true, ...await service.restore(req.user, req.params.id, req.params.versionId, req.body) })));
    router.post('/apps/mindmaps/:id/exports', asyncHandler(async (req, res) => res.status(202).json({ success: true, job: await exportsService.create(req.user, req.params.id, req.body) })));
}
module.exports = { registerMindmapRoutes };
