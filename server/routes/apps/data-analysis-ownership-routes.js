'use strict';

const { handler: asyncHandler } = require('../../services/data-analysis/bi/delivery');
const ownership = require('../../services/data-analysis/bi/ownership');

function registerDataAnalysisOwnershipRoutes(router, { authMiddleware }) {
    router.post('/apps/data-analysis/models/:modelId/transfer-preview', authMiddleware, asyncHandler(async (req, res) => {
        res.json(await ownership.previewTransfer({ user: req.user, modelId: req.params.modelId, body: req.body || {} }));
    }));
    router.post('/apps/data-analysis/models/:modelId/transfers', authMiddleware, asyncHandler(async (req, res) => {
        res.status(201).json({ transfer: await ownership.requestTransfer({ user: req.user, modelId: req.params.modelId, body: req.body || {} }) });
    }));
    router.get('/apps/data-analysis/model-transfers', authMiddleware, asyncHandler(async (req, res) => { res.json({ transfers: await ownership.transferInbox(req.user) }); }));
    router.get('/apps/data-analysis/model-transfers/:id', authMiddleware, asyncHandler(async (req, res) => { res.json({ transfer: await ownership.getTransfer(req.user, req.params.id) }); }));
    router.post('/apps/data-analysis/model-transfers/:id/decision', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ transfer: await ownership.decideTransfer({ user: req.user, id: req.params.id, body: req.body || {} }) });
    }));
}

module.exports = { registerDataAnalysisOwnershipRoutes };
