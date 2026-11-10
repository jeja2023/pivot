'use strict';

const { asyncHandler } = require('../../../http');
const { createSafeUpload, removeUploadedFile } = require('../../../upload');
const runtime = require('../../../services/policy-review/runtime');
const { invalid } = require('../../../services/policy-review/contract');

function registerReviewRoutes(router, { authMiddleware, logAction, uploadLimiter }) {
    const limiter = require('express-rate-limit')({ store: require('../../../services/rate-limit-store').createRateLimitStore('policy-review'), windowMs: 60000, limit: 30,
        keyGenerator: req => String(req.user.id), message: { error: '材料审查操作过于频繁，请稍后重试。' } });
    const upload = createSafeUpload({ extensions: new Set(['.txt', '.md', '.docx', '.pdf']), fileSize: 8 * 1024 * 1024, maxFields: 0, errorMessage: '待审材料支持TXT、Markdown、Word和文本型PDF。' });
    router.use('/reviews', authMiddleware, limiter, (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
    const found = value => { if (!value) throw invalid('审查任务不存在或无权访问。', 404, 'POLICY_REVIEW_NOT_FOUND'); return value; };
    router.get('/reviews', asyncHandler(async (req, res) => res.json(await runtime.page(req.user, req.query))));
    router.post('/reviews/materials', uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
        try { res.status(201).json({ material: await require('../../../services/policy-review/materials').extract(req.user, req.file) }); }
        finally { await removeUploadedFile(req.file); }
    }));
    router.post('/reviews', asyncHandler(async (req, res) => {
        const task = await runtime.start(req.user, req.body || {});
        logAction?.(req, '创建制度材料审查', '任务: ' + task.id);
        res.status(202).json({ task });
    }));
    router.get('/reviews/:id', asyncHandler(async (req, res) => res.json({ task: found(await runtime.get(req.user, req.params.id)) })));
    router.post('/reviews/:id/cancel', asyncHandler(async (req, res) => res.json({ task: found(await runtime.cancel(req.user, req.params.id)) })));
    router.post('/reviews/:id/resume', asyncHandler(async (req, res) => res.json({ task: found(await runtime.resume(req.user, req.params.id)) })));
    router.delete('/reviews/:id', asyncHandler(async (req, res) => {
        res.json({ task: found(await runtime.withdraw(req.user, req.params.id)) });
    }));
    router.put('/reviews/:id/report', asyncHandler(async (req, res) => {
        found(await require('../../../services/policy-review/report').save(req.user, req.params.id, req.body || {}));
        res.json({ task: found(await runtime.get(req.user, req.params.id, { recover: false })) });
    }));
    router.post('/reviews/:id/export', asyncHandler(async (req, res) => {
        const delivery = found(await require('../../../services/policy-review/delivery').exportReport(req.user, req.params.id, req.body?.version));
        logAction?.(req, '导出制度材料审查报告', '任务: ' + req.params.id + '，版本: ' + delivery.version);
        res.json({ delivery });
    }));
}

module.exports = { registerReviewRoutes };
