const { asyncHandler } = require('../http');
const {
    deleteWorkflowApiOperation,
    importOpenApiOperations,
    listWorkflowApiOperations
} = require('../services/workflow-api-operations');

function registerAgentApiOperationRoutes(router, { authMiddleware, automationGuard, logAction }) {
    router.get('/agents/api-operations', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listWorkflowApiOperations(req.user, { includeInactive: req.query.includeInactive === 'true' }) });
    }));
    router.post('/agents/api-operations/import-openapi', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const result = await importOpenApiOperations(req.user, req.body || {});
        logAction(req, '导入工作流 API 操作', `导入 ${result.count} 个操作，文档摘要: ${result.sourceDigest}`);
        res.status(201).json({ success: true, ...result });
    }));
    router.delete('/agents/api-operations/:id', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const operation = await deleteWorkflowApiOperation(req.params.id, req.user);
        if (!operation) return res.status(404).json({ error: 'API 操作不存在或无权删除。' });
        logAction(req, '停用工作流 API 操作', `操作: ${operation.title}`);
        res.json({ success: true, operation });
    }));
}

module.exports = { registerAgentApiOperationRoutes };
