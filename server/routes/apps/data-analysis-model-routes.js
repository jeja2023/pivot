'use strict';

const { handler: asyncHandler } = require('../../services/data-analysis/bi/delivery');
const { saveProductionDraft, archiveProductionModel } = require('../../services/data-analysis/bi/models');
const jobs = require('../../services/data-analysis/bi/jobs');
const versions = require('../../services/data-analysis/bi/versions');
const sharing = require('../../services/data-analysis/bi/sharing');
const results = require('../../services/data-analysis/bi/results');
const consumers = require('../../services/data-analysis/bi/consumers');
const flowPipeline = require('../../services/data-analysis/bi/flow-pipeline');

function registerDataAnalysisModelRoutes(router, { authMiddleware }) {
    router.use('/apps/data-analysis', (req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
    router.use('/apps/data-analysis', require('../../services/data-analysis/bi/operations').controlMiddleware);
    require('./data-analysis-operation-routes').registerDataAnalysisOperationRoutes(router, { authMiddleware });
    require('./data-analysis-ownership-routes').registerDataAnalysisOwnershipRoutes(router, { authMiddleware });
    require('./data-analysis-migration-routes').registerDataAnalysisMigrationRoutes(router, { authMiddleware });
    require('./data-analysis-source-routes').registerDataAnalysisSourceRoutes(router, { authMiddleware });
    router.get('/apps/data-analysis/modeling-functions', authMiddleware, asyncHandler(async (_req, res) => {
        res.json({ success: true, functions: flowPipeline.FLOW_BUILTIN_FUNCTIONS });
    }));
    router.post('/apps/data-analysis/models/:modelId/node-preview', authMiddleware, asyncHandler(async (req, res) => {
        const preview = await flowPipeline.previewModelNode({ user: req.user, modelId: req.params.modelId, body: req.body || {} });
        res.json({ success: true, preview });
    }));
    router.post('/apps/data-analysis/models/:modelId/node-datasets', authMiddleware, asyncHandler(async (req, res) => {
        const created = await flowPipeline.materializeModelNodeDataset({ user: req.user, modelId: req.params.modelId, body: req.body || {} });
        res.status(201).json({ success: true, ...created });
    }));
    router.put('/apps/data-analysis/models/:modelId/draft', authMiddleware, asyncHandler(async (req, res) => {
        const model = await saveProductionDraft({ user: req.user, modelId: req.params.modelId, body: req.body || {} });
        res.json({ success: true, model });
    }));
    router.delete('/apps/data-analysis/models/:modelId', authMiddleware, asyncHandler(async (req, res, next) => {
        const row = await require('../../repositories/analysis-production-models').get(req.params.modelId);
        if (!row || row.model_kind !== 'production') return next();
        const result = await require('../../services/data-analysis/bi/models').deleteProductionModel({ user: req.user, modelId: req.params.modelId, expectedVersion: req.body?.expectedVersion });
        res.json({ success: true, ...result });
    }));
    router.post('/apps/data-analysis/models/:modelId/archive', authMiddleware, asyncHandler(async (req, res) => {
        const model = await archiveProductionModel({ user: req.user, modelId: req.params.modelId, body: req.body || {} });
        res.json({ success: true, model });
    }));
    router.post('/apps/data-analysis/models/:modelId/checks', authMiddleware, asyncHandler(async (req, res) => {
        const result = await jobs.createModelCheck({ user: req.user, modelId: req.params.modelId, body: req.body || {} });
        res.status(202).json({ success: true, ...result });
    }));
    router.get('/apps/data-analysis/models/:modelId/checks/:checkId', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ check: await jobs.getModelCheck(req.user, req.params.modelId, req.params.checkId) });
    }));
    router.post('/apps/data-analysis/models/:modelId/publish', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ success: true, version: await jobs.publishModel({ user: req.user, modelId: req.params.modelId, body: req.body || {} }) });
    }));
    router.get('/apps/data-analysis/models/:modelId/versions', authMiddleware, asyncHandler(async (req, res) => {
        res.json(await versions.modelVersions(req.user, req.params.modelId, { compareVersion: req.query.compareVersion ?? null }));
    }));
    router.get('/apps/data-analysis/models/:modelId/dependencies', authMiddleware, asyncHandler(async (req, res) => {
        res.json(await versions.modelDependencies(req.user, req.params.modelId));
    }));
    router.post('/apps/data-analysis/models/:modelId/rollback', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ model: await versions.rollbackModel({ user: req.user, modelId: req.params.modelId, body: req.body || {} }) });
    }));
    router.post('/apps/data-analysis/models/:modelId/data-refresh', authMiddleware, asyncHandler(async (req, res) => {
        res.status(202).json(await jobs.createModelRefresh({ user: req.user, modelId: req.params.modelId, body: req.body || {} }));
    }));
    router.post('/apps/data-analysis/models/:modelId/review-requests', authMiddleware, asyncHandler(async (req, res) => {
        res.status(201).json({ review: await sharing.requestModelReview({ user: req.user, modelId: req.params.modelId, body: req.body || {} }) });
    }));
    router.put('/apps/data-analysis/models/:modelId/sharing', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ model: await sharing.changeModelSharing({ user: req.user, modelId: req.params.modelId, body: req.body || {} }) });
    }));
    router.get('/apps/data-analysis/model-reviews', authMiddleware, asyncHandler(async (req, res) => { res.json({ reviews: await sharing.reviewInbox(req.user) }); }));
    router.get('/apps/data-analysis/model-reviews/:reviewId', authMiddleware, asyncHandler(async (req, res) => { res.json({ review: await sharing.getModelReview(req.user, req.params.reviewId) }); }));
    router.post('/apps/data-analysis/model-reviews/:reviewId/decision', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ review: await sharing.decideModelReview({ user: req.user, reviewId: req.params.reviewId, body: req.body || {} }) });
    }));
    router.get('/apps/data-analysis/async-queries/:jobId/results', authMiddleware, asyncHandler(async (req, res) => {
        req.originalUrl = String(req.originalUrl || req.url).split('?')[0];
        res.json(await results.resultPage({ user: req.user, jobId: req.params.jobId, session: results.sessionFingerprint(req), cursor: req.query.cursor || '', limit: req.query.limit === undefined ? 100 : Number(req.query.limit) }));
    }));
    router.post('/apps/data-analysis/async-queries/:jobId/exports', authMiddleware, asyncHandler(async (req, res) => {
        res.status(202).json({ job: await results.createModelExport({ user: req.user, jobId: req.params.jobId, body: req.body || {} }) });
    }));
    router.post('/apps/data-analysis/async-queries/:jobId/download-token', authMiddleware, asyncHandler(async (req, res) => {
        res.json(await results.issueDownload({ user: req.user, jobId: req.params.jobId, session: results.sessionFingerprint(req) }));
    }));
    router.get('/apps/data-analysis/async-queries/:jobId/export-content', authMiddleware, asyncHandler(async (req, res) => {
        await results.downloadModelExport({ user: req.user, jobId: req.params.jobId, session: results.sessionFingerprint(req), token: req.headers['x-analysis-download-token'], range: req.headers.range, response: res });
    }));
    for (const edit of [false, true]) router[edit ? 'put' : 'post'](`/apps/data-analysis/models/:modelId/views${edit ? '/:viewId' : ''}`, authMiddleware, asyncHandler(async (req, res) => {
        res.status(edit ? 200 : 201).json({ view: await consumers.saveModelView({ user: req.user, modelId: req.params.modelId, viewId: req.params.viewId || null, body: req.body || {} }) });
    }));
    router.post('/apps/data-analysis/async-queries/:jobId/pivot', authMiddleware, asyncHandler(async (req, res) => {
        res.status(202).json(await consumers.createModelPivot({ user: req.user, jobId: req.params.jobId, body: req.body || {} }));
    }));
    router.post('/apps/data-analysis/dashboards/:dashboardId/items/:itemId/model-run', authMiddleware, asyncHandler(async (req, res) => {
        res.status(202).json(await consumers.runModelDashboardItem({ user: req.user, dashboardId: req.params.dashboardId, itemId: req.params.itemId }));
    }));
    for (const trial of [false, true]) router.post(`/apps/data-analysis/models/:modelId/${trial ? 'trial-queries' : 'queries'}`, authMiddleware, asyncHandler(async (req, res) => {
        const job = await jobs.submitModelQuery({ user: req.user, modelId: req.params.modelId, body: req.body || {}, trial });
        res.status(['queued', 'running', 'retry_wait', 'cancelling'].includes(job.status) ? 202 : 200).json({ success: true, job });
    }));
}

module.exports = { registerDataAnalysisModelRoutes };
