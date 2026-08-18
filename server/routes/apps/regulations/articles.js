const { asyncHandler } = require('../../../http');
const {
    isAdmin,
    buildRegulationQaReport,
    createRegulationAnnotation,
    createSavedSearch,
    deleteRegulationAnnotation,
    deleteSavedSearch,
    findSimilarRegulationArticles,
    listRegulationAccessLogs,
    listRegulationAnnotations,
    listSavedSearches,
    requireRegulationsAdmin,
    searchRegulationArticlesHybrid,
    setRegulationArticleStatus,
    updateRegulationAnnotation
} = require('./helpers');

function registerArticleRoutes(router, deps) {
    const { authMiddleware, logAction } = deps;

    // #8 设置条文级状态（管理员）
    router.put('/articles/:articleId/status', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireRegulationsAdmin(req, res)) return;
        const updated = await setRegulationArticleStatus({
            articleId: req.params.articleId,
            status: req.body?.status,
            amendedDate: req.body?.amendedDate || req.body?.amended_date || ''
        });
        if (!updated) {
            return res.status(404).json({ error: { message: '条文不存在', type: 'invalid_request_error' } });
        }
        logAction(req, '法规查询设置条文状态', `条文 ${req.params.articleId} → ${updated.status}`);
        res.json({ article: updated });
    }));

    // #10 条文批注 CRUD
    router.get('/articles/:articleId/annotations', authMiddleware, asyncHandler(async (req, res) => {
        const annotations = await listRegulationAnnotations({ articleId: req.params.articleId });
        res.json({ annotations });
    }));

    router.post('/articles/:articleId/annotations', authMiddleware, asyncHandler(async (req, res) => {
        const annotation = await createRegulationAnnotation({
            articleId: req.params.articleId,
            userId: req.user.id,
            content: req.body?.content
        });
        if (!annotation) {
            return res.status(400).json({ error: { message: '批注内容不能为空或条文不存在', type: 'invalid_request_error' } });
        }
        logAction(req, '法规查询新增批注', `条文 ${req.params.articleId}`);
        res.json({ annotation });
    }));

    router.put('/annotations/:annotationId', authMiddleware, asyncHandler(async (req, res) => {
        const annotation = await updateRegulationAnnotation({
            annotationId: req.params.annotationId,
            userId: req.user.id,
            content: req.body?.content
        });
        if (!annotation) {
            return res.status(403).json({ error: { message: '批注不存在或无权编辑', type: 'forbidden' } });
        }
        res.json({ annotation });
    }));

    router.delete('/annotations/:annotationId', authMiddleware, asyncHandler(async (req, res) => {
        const ok = await deleteRegulationAnnotation({
            annotationId: req.params.annotationId,
            userId: req.user.id
        });
        if (!ok) {
            return res.status(403).json({ error: { message: '批注不存在或无权删除', type: 'forbidden' } });
        }
        res.json({ success: true });
    }));

    // #11 AI 回答导出为合规报告（Markdown）
    router.post('/report', authMiddleware, asyncHandler(async (req, res) => {
        const body = req.body || {};
        const markdown = buildRegulationQaReport({
            question: body.question,
            answer: body.answer,
            sources: Array.isArray(body.sources) ? body.sources : []
        });
        logAction(req, '法规查询导出合规报告', `问题：${String(body.question || '').slice(0, 40)}`);
        res.json({ markdown });
    }));

    // #12 查阅审计日志（管理员）
    router.get('/access-logs', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireRegulationsAdmin(req, res)) return;
        const result = await listRegulationAccessLogs({
            documentId: req.query.documentId,
            userId: req.query.userId,
            limit: req.query.limit,
            offset: req.query.offset
        });
        res.json(result);
    }));

    // #2 混合检索（可选，向量端点未配置时自动降级为 BM25）
    router.get('/search/hybrid', authMiddleware, asyncHandler(async (req, res) => {
        const matches = await searchRegulationArticlesHybrid({
            query: req.query.q || req.query.query,
            documentId: req.query.documentId || req.query.document_id,
            limit: req.query.limit,
            includeArchived: isAdmin(req.user) && req.query.includeArchived === 'true',
            userId: req.user.id
        });
        res.json({ matches });
    }));

    // #14 相似条文推荐
    router.get('/articles/:articleId/similar', authMiddleware, asyncHandler(async (req, res) => {
        const similar = await findSimilarRegulationArticles({
            articleId: req.params.articleId,
            limit: req.query.limit
        });
        res.json({ similar });
    }));

    // #14 保存检索 CRUD
    router.get('/saved-searches', authMiddleware, asyncHandler(async (req, res) => {
        const searches = await listSavedSearches({ userId: req.user.id });
        res.json({ searches });
    }));

    router.post('/saved-searches', authMiddleware, asyncHandler(async (req, res) => {
        const search = await createSavedSearch({
            userId: req.user.id,
            name: req.body?.name,
            query: req.body?.query,
            category: req.body?.category,
            jurisdiction: req.body?.jurisdiction
        });
        if (!search) {
            return res.status(400).json({ error: { message: '名称不能为空', type: 'invalid_request_error' } });
        }
        res.json({ search });
    }));

    router.delete('/saved-searches/:searchId', authMiddleware, asyncHandler(async (req, res) => {
        const ok = await deleteSavedSearch({
            searchId: req.params.searchId,
            userId: req.user.id
        });
        if (!ok) {
            return res.status(403).json({ error: { message: '检索不存在或无权删除', type: 'forbidden' } });
        }
        res.json({ success: true });
    }));

}

module.exports = {
    registerArticleRoutes
};
