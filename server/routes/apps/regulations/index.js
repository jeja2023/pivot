const express = require('express');
const { registerAiRoutes } = require('./ai');
const { registerArticleRoutes } = require('./articles');
const { registerDocumentRoutes } = require('./documents');

function createRegulationsRouter({ authMiddleware, logAction, uploadLimiter, upload, runAppsAiCompletion }) {
    const router = express.Router();
    const deps = { authMiddleware, logAction, uploadLimiter, upload, runAppsAiCompletion };

    registerDocumentRoutes(router, deps);
    registerArticleRoutes(router, deps);
    registerAiRoutes(router, deps);

    return router;
}

module.exports = {
    createRegulationsRouter
};
