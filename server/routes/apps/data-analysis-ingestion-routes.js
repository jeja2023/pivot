'use strict';

const express = require('express');
const { asyncHandler } = require('../../http');
const service = require('../../services/data-analysis/bi/ingestions');

function registerDataAnalysisIngestionRoutes(router, { authMiddleware }) {
    const root = '/apps/data-analysis/ingestions';
    router.use(root, (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
    router.get(root, authMiddleware, asyncHandler(async (req, res) => res.json({ ingestions: await service.listIngestions(req.user) })));
    router.post(root, authMiddleware, asyncHandler(async (req, res) => res.status(201).json({ ingestion: await service.createIngestion(req.user, req.body || {}) })));
    router.get(`${root}/:id`, authMiddleware, asyncHandler(async (req, res) => res.json({ ingestion: await service.getIngestion(req.user, req.params.id) })));
    router.put(`${root}/:id/chunks/:index`, authMiddleware, (req, res, next) => {
        if (!req.is('application/octet-stream')) return res.status(415).json({ error: '分块必须使用二进制文件内容。' });
        if (!/^(?:0|[1-9][0-9]{0,2})$/.test(req.params.index)) return res.status(400).json({ error: '分块序号不正确。' });
        next();
    }, express.raw({ type: 'application/octet-stream', limit: '8mb', inflate: false }), asyncHandler(async (req, res) => {
        const chunk = await service.putIngestionChunk(req.user, req.params.id, Number(req.params.index), req.body, req.get('X-Content-SHA256'));
        res.json({ chunk });
    }));
    router.post(`${root}/:id/submit`, authMiddleware, asyncHandler(async (req, res) => res.status(202).json({ ingestion: await service.submitIngestion(req.user, req.params.id) })));
    router.post(`${root}/:id/cancel`, authMiddleware, asyncHandler(async (req, res) => res.json({ ingestion: await service.cancelIngestion(req.user, req.params.id) })));
}

module.exports = { registerDataAnalysisIngestionRoutes };
