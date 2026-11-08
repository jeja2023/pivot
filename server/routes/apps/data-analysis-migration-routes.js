'use strict';

const { handler: asyncHandler } = require('../../services/data-analysis/bi/delivery');
const migration = require('../../services/data-analysis/bi/migration');
function registerDataAnalysisMigrationRoutes(router, { authMiddleware }) {
    router.get('/apps/data-analysis/models/:modelId/migration-inventory', authMiddleware, asyncHandler(async (req, res) => {
        res.json(await migration.migrationInventory({ user: req.user, modelId: req.params.modelId }));
    }));
    router.post('/apps/data-analysis/models/:modelId/formal-drafts', authMiddleware, asyncHandler(async (req, res) => {
        res.status(201).json({ model: await migration.migrateExploration({ user: req.user, modelId: req.params.modelId, body: req.body || {} }) });
    }));
}
module.exports = { registerDataAnalysisMigrationRoutes };
