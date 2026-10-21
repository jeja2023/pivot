const { asyncHandler } = require('../http');
const service = require('../services/workflow-editor-experience');
const repository = require('../repositories/workflow-editor-drafts');
const { propose } = require('../services/workflow-ai-authoring');

function registerWorkflowEditorRoutes(router, authMiddleware) {
    router.post('/agents/workflow-editor/propose', authMiddleware, asyncHandler(async (req, res) => res.json(await propose(req.user, req.body || {}))));
    router.get('/agents/workflow-editor/drafts', authMiddleware, asyncHandler(async (req, res) => res.json({ data: await repository.list(req.user.id) })));
    router.get('/agents/workflow-editor/drafts/:key', authMiddleware, asyncHandler(async (req, res) => res.json({ draft: await service.getDraft(req.user, req.params.key) })));
    router.put('/agents/workflow-editor/drafts/:key', authMiddleware, asyncHandler(async (req, res) => res.json({ draft: await service.saveDraft(req.user, req.params.key, req.body) })));
    router.delete('/agents/workflow-editor/drafts/:key', authMiddleware, asyncHandler(async (req, res) => {
        await repository.remove(req.user.id, service.key(req.params.key)); res.json({ success: true });
    }));
    router.get('/agents/workflow-editor/preferences', authMiddleware, asyncHandler(async (req, res) => res.json({ data: await repository.preferences(req.user.id) })));
    router.get('/agents/workflow-editor/recent-runs', authMiddleware, asyncHandler(async (req, res) => res.json({ data: await repository.recentRuns(req.user.id) })));
    router.patch('/agents/workflows/:id/preference', authMiddleware, asyncHandler(async (req, res) => res.json({ preference: await service.preference(req.user, req.params.id, req.body || {}) })));
    router.get('/agents/workflows/:id/run-context', authMiddleware, asyncHandler(async (req, res) => res.json(await service.runContext(req.user, req.params.id))));
}
module.exports = { registerWorkflowEditorRoutes };
