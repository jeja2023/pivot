/**
 * 工作流模板 API 路由
 *
 * 端点：
 * - GET    /api/agent/workflow-templates              获取模板列表
 * - GET    /api/agent/workflow-templates/:id          获取模板详情
 * - POST   /api/agent/workflow-templates              创建模板
 * - POST   /api/agent/workflow-templates/:id/apply    应用模板
 * - POST   /api/agent/workflow-templates/:id/rate     评分模板
 * - GET    /api/agent/workflow-template-categories    获取分类列表
 */

const express = require('express');
const { WorkflowTemplateService, WorkflowTemplateError } = require('../../services/agent/workflowTemplateService');
const { asyncHandler } = require('../../http');

/**
 * 创建工作流模板路由
 * @param {Object} options - 路由配置
 * @param {Function} options.authMiddleware - 认证中间件
 * @param {Function} options.logAction - 日志记录函数
 */
function createWorkflowTemplatesRouter({ authMiddleware, logAction }) {
    const router = express.Router();

    /**
     * GET /api/agent/workflow-templates
     * 获取模板列表
     */
    router.get('/agent/workflow-templates', authMiddleware, asyncHandler(async (req, res) => {
        const {
            category,
            difficulty,
            search,
            sortBy,
            sortOrder,
            page = 1,
            pageSize = 20,
            limit,
            includePrivate = 'false',
            is_builtin
        } = req.query;

        const effectivePageSize = limit ? parseInt(limit, 10) : parseInt(pageSize, 10);

        const options = {
            category,
            difficulty,
            search,
            sortBy,
            sortOrder,
            page: parseInt(page, 10),
            pageSize: effectivePageSize,
            limit: effectivePageSize,
            includePrivate: includePrivate === 'true',
            isBuiltin: is_builtin === 'true' ? true : (is_builtin === 'false' ? false : undefined),
            userId: req.user?.id
        };

        const result = await WorkflowTemplateService.listTemplates(options);

        res.json({
            success: true,
            data: result.templates,
            pagination: result.pagination
        });
    }));

    /**
     * GET /api/agent/workflow-templates/:slugOrId
     * 获取模板详情
     */
    router.get('/agent/workflow-templates/:slugOrId', authMiddleware, asyncHandler(async (req, res) => {
        const { slugOrId } = req.params;
        const template = await WorkflowTemplateService.getTemplateDetail(slugOrId, req.user.id);

        res.json({
            success: true,
            data: template
        });
    }));

    /**
     * POST /api/agent/workflow-templates
     * 创建模板
     */
    router.post('/agent/workflow-templates', authMiddleware, asyncHandler(async (req, res) => {
        const templateData = req.body;
        const template = await WorkflowTemplateService.createTemplate(templateData, req.user.id);

        logAction(req, '创建工作流模板', `模板: ${template.name} (ID: ${template.id})`);

        res.status(201).json({
            success: true,
            data: template,
            message: '模板创建成功'
        });
    }));

    /**
     * POST /api/agent/workflow-templates/:id/apply
     * 应用模板（创建工作流）
     */
    router.post('/agent/workflow-templates/:id/apply', authMiddleware, asyncHandler(async (req, res) => {
        const { id } = req.params;
        const { variables } = req.body;

        if (!variables || typeof variables !== 'object') {
            throw new WorkflowTemplateError('请提供变量值', 400);
        }

        const workflow = await WorkflowTemplateService.applyTemplate(
            parseInt(id, 10),
            variables,
            req.user.id
        );

        logAction(req, '应用工作流模板', `模板ID: ${id}, 工作流: ${workflow.name} (ID: ${workflow.id})`);

        res.status(201).json({
            success: true,
            data: workflow,
            message: '工作流创建成功'
        });
    }));

    /**
     * POST /api/agent/workflow-templates/:id/rate
     * 评分模板
     */
    router.post('/agent/workflow-templates/:id/rate', authMiddleware, asyncHandler(async (req, res) => {
        const { id } = req.params;
        const { rating, comment } = req.body;

        const parsedRating = typeof rating === 'number' ? rating : (typeof rating === 'string' && /^[1-5]$/.test(rating) ? Number(rating) : NaN);
        if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
            throw new WorkflowTemplateError('评分必须在 1-5 之间', 400);
        }

        const result = await WorkflowTemplateService.rateTemplate(
            parseInt(id, 10),
            parsedRating,
            comment || '',
            req.user.id
        );

        logAction(req, '评分工作流模板', `模板ID: ${id}, 评分: ${rating}星`);

        res.json({
            success: true,
            data: result,
            message: '评分成功'
        });
    }));

    /**
     * GET /api/agent/workflow-template-categories
     * 获取分类列表
     */
    router.get('/agent/workflow-template-categories', authMiddleware, asyncHandler(async (req, res) => {
        const categories = await WorkflowTemplateService.listCategories();

        res.json({
            success: true,
            data: categories
        });
    }));

    return router;
}

module.exports = { createWorkflowTemplatesRouter };
