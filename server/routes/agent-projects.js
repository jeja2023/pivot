'use strict';
const { asyncHandler } = require('../http');
const service = require('../services/agent-projects');
module.exports = function registerAgentProjects(router, { authMiddleware, logAction }) {
    router.get('/agents/projects', authMiddleware, asyncHandler(async (req, res) => res.json(await service.list(req.user, req.query))));
    router.get('/agents/projects/:id', authMiddleware, asyncHandler(async (req, res) => res.json(await service.detail(req.user, req.params.id, req.query))));
    router.post('/agents/projects', authMiddleware, asyncHandler(async (req, res) => {
        const project = await service.save(req.user, null, req.body);
        logAction?.(req, '创建智能体项目', `项目：${project.id}`);
        res.status(201).json({ project });
    }));
    router.put('/agents/projects/:id', authMiddleware, asyncHandler(async (req, res) => {
        const project = await service.save(req.user, req.params.id, req.body);
        logAction?.(req, '更新智能体项目', `项目：${project.id}，版本：${project.version}`);
        res.json({ project });
    }));
};
