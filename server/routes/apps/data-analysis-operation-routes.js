'use strict';

const { asyncHandler } = require('../../http');
const operations = require('../../services/data-analysis/bi/operations');
const probe = require('../../services/data-analysis/bi/operation-probe');

function registerDataAnalysisOperationRoutes(router, { authMiddleware }) {
    router.get('/apps/data-analysis/operations/release', authMiddleware, asyncHandler(async (req, res) => res.json(await require('../../services/data-analysis/bi/release-controls').overview(req.user))));
    router.post('/apps/data-analysis/operations/release', authMiddleware, asyncHandler(async (req, res) => res.json(await require('../../services/data-analysis/bi/release-controls').act(req.user, req.body || {}))));
    router.get('/apps/data-analysis/operations', authMiddleware, asyncHandler(async (req, res) => res.json(await operations.overview(req.user))));
    router.post('/apps/data-analysis/operations/preflight', authMiddleware, asyncHandler(async (req, res) => res.json(await operations.fullPreflight(req.user))));
    router.post('/apps/data-analysis/operations/probe', authMiddleware, asyncHandler(async (req, res) => res.json(await probe.configure(req.user, req.body || {}))));
    router.post('/apps/data-analysis/operations/check', authMiddleware, asyncHandler(async (req, res) => { await operations.requireOperator(req.user); res.json(await operations.tick()); }));
    router.post('/apps/data-analysis/operations/resume', authMiddleware, asyncHandler(async (req, res) => res.json(await operations.resume(req.user, req.body?.reason))));
    router.post('/apps/data-analysis/operations/fence', authMiddleware, asyncHandler(async (req, res) => res.json(await operations.fence(req.user, req.body?.reason))));
}

module.exports = { registerDataAnalysisOperationRoutes };
