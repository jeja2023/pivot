'use strict';
const { asyncHandler } = require('../../http');
const { compareDocuments, comparisonIr } = require('../../services/document-comparison');
const { executeArtifactTool } = require('../../services/agent-tools-artifacts');

function registerDocumentComparisonRoutes(router, { authMiddleware, logAction }) {
    const saveLimiter = require('express-rate-limit')({ windowMs: 60000, limit: 30, keyGenerator: req => String(req.user.id), message: { error: '文档或脑图处理过于频繁，请稍后重试。' } });
    router.post('/apps/official-writing/compare', authMiddleware, saveLimiter, asyncHandler(async (req, res) => {
        const comparison = compareDocuments(req.body?.before, req.body?.after, req.body?.mode || 'character');
        let delivery;
        if (req.body?.exportDocx === true) delivery = await executeArtifactTool('artifact.render', {
            ir: comparisonIr(comparison, req.body?.title), format: 'docx'
        }, req.user, { stepId: `comparison:${require('crypto').randomUUID()}` });
        logAction?.(req, '文档精细比较', { changed: comparison.changed, moves: comparison.moves.length, artifactId: delivery?.artifactId });
        res.json({ success: true, comparison, delivery });
    }));
}
module.exports = { registerDocumentComparisonRoutes };
