'use strict';

const actions = require('../../services/presentations/presentation-design-actions');

function registerPresentationDesignRoutes(router, { authMiddleware, asyncHandler, writeLog }) {
    router.get('/apps/presentations/design/info', authMiddleware, asyncHandler(async (req, res) => res.json(await actions.designInfo(req.user))));
    router.post('/apps/presentations/:id/visual-review', authMiddleware, asyncHandler(async (req, res) => {
        const { slideIndex, model } = req.body || {};
        if (!Number.isInteger(slideIndex) || slideIndex < 0 || (model !== undefined && (typeof model !== 'string' || model.length > 160))) return res.status(400).json({ error: '请选择有效页码和模型。' });
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        req.once('aborted', onAbort);
        res.once('close', () => { if (!res.writableEnded) onAbort(); });
        try {
            const review = await actions.review(req.user, { presentationId: req.params.id, slideIndex, modelId: model }, { signal: controller.signal });
            writeLog(req, 'PPT视觉复核', `文稿: ${req.params.id}，页码: ${slideIndex + 1}，状态: ${review.status}`);
            res.json({ review });
        } finally { req.removeListener('aborted', onAbort); }
    }));
}

module.exports = { registerPresentationDesignRoutes };
