'use strict';

const { handler } = require('../../services/data-analysis/bi/delivery');
const { getSourceInformation, saveSourceInformation } = require('../../services/data-analysis/bi/source-information');

function registerDataAnalysisSourceRoutes(router, { authMiddleware }) {
    router.get('/apps/data-analysis/datasets/:id/source-metadata', authMiddleware, handler(async (req, res) => {
        res.json({ source: await getSourceInformation(req.user, req.params.id) });
    }));
    router.put('/apps/data-analysis/datasets/:id/source-metadata', authMiddleware, handler(async (req, res) => {
        res.json({ success: true, source: await saveSourceInformation(req.user, req.params.id, req.body || {}) });
    }));
}

module.exports = { registerDataAnalysisSourceRoutes };
