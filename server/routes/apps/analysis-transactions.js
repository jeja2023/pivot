'use strict';
const { asyncHandler } = require('../../http');
const service = require('../../services/data-analysis/transactions');
function registerTransactionRoutes(router, { authMiddleware, logAction = () => {} }) {
    const limiter = require('express-rate-limit')({ store: require('../../services/rate-limit-store').createRateLimitStore('analysis:transactions'), windowMs: 60000, limit: 60, keyGenerator: req => String(req.user.id), message: { error: '资金分析请求过于频繁，请稍后重试。' } });
    router.use('/apps/data-analysis/transactions', authMiddleware, limiter);
    router.get('/apps/data-analysis/transactions', asyncHandler(async (req, res) => res.json({ rows: await service.list(req.user, String(req.query.datasetId || '')) })));
    router.post('/apps/data-analysis/transactions', asyncHandler(async (req, res) => { const job = await service.create(req.user, req.body?.datasetId, req.body); logAction(req, '创建资金交易分析', `分析编号: ${job.id}`); res.status(202).json({ job }); }));
    router.get('/apps/data-analysis/transactions/:id', asyncHandler(async (req, res) => res.json({ job: await service.get(req.user, req.params.id) })));
    router.delete('/apps/data-analysis/transactions/:id', asyncHandler(async (req, res) => { await service.remove(req.user, req.params.id); logAction(req, '删除资金交易分析', `分析编号: ${req.params.id}`); res.json({ success: true }); }));
    router.get('/apps/data-analysis/transactions/:id/outputs', asyncHandler(async (req, res) => res.json({ rows: await require('../../services/data-analysis/transaction-delivery').list(req.user, req.params.id) })));
    router.post('/apps/data-analysis/transactions/:id/outputs', asyncHandler(async (req, res) => { const output = await require('../../services/data-analysis/transaction-delivery').create(req.user, req.params.id, req.body?.format); logAction(req, '导出资金交易分析', `分析编号: ${req.params.id}，格式: ${output.format}`); res.status(202).json({ output }); }));
    router.post('/apps/data-analysis/transactions/:id/ai', asyncHandler(async (req, res) => { const prepared = await require('../../services/data-analysis/transaction-report').prepareAi(req.user, req.params.id); return require('./helpers').runAppsAiCompletion({ req, res, logAction, source: 'apps.transactions', auditAction: '解读资金交易分析', maxTokens: 2000, messages: prepared.messages, transformCompletion: prepared.verifyTransactionExplanation }); }));
}
module.exports = { registerTransactionRoutes };
