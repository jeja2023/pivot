const { asyncHandler } = require('../../../http');
const {
    isAdmin,
    buildRegulationQaReport,
    buildRegulationQaReportIr,
    createRegulationAnnotation,
    createSavedSearch,
    deleteRegulationAnnotation,
    deleteSavedSearch,
    findSimilarRegulationArticles,
    getReadableRegulationArticle,
    getRegulationVersionStorageById,
    listRegulationArticleLocations,
    listRegulationAccessLogs,
    listRegulationAnnotations,
    listSavedSearches,
    recordRegulationAccess,
    requireRegulationsAdmin,
    searchRegulationArticlesHybrid,
    setRegulationArticleStatus,
    updateRegulationAnnotation
} = require('./helpers');
const { renderDocumentIr } = require('../../../services/document-rendering');

function registerArticleRoutes(router, deps) {
    const { authMiddleware, logAction } = deps;

    // #8 设置条文级状态（管理员）
    router.put('/articles/:articleId/status', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireRegulationsAdmin(req, res)) return;
        const article = await getReadableRegulationArticle(req.params.articleId, { includeArchived: isAdmin(req.user) });
        if (!article) {
            return res.status(404).json({ error: { message: '条文不存在或不可访问', type: 'invalid_request_error' } });
        }
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
        const annotations = await listRegulationAnnotations({ articleId: req.params.articleId, includeArchived: isAdmin(req.user) });
        if (!annotations.length) {
            const article = await getReadableRegulationArticle(req.params.articleId, { includeArchived: isAdmin(req.user) });
            if (!article) return res.status(404).json({ error: { message: '条文不存在或不可访问', type: 'invalid_request_error' } });
        }
        res.json({ annotations });
    }));

    router.get('/articles/:articleId/locations', authMiddleware, asyncHandler(async (req, res) => {
        const article = await getReadableRegulationArticle(req.params.articleId, { includeArchived: isAdmin(req.user) });
        if (!article) return res.status(404).json({ error: { message: '条文不存在或不可访问', type: 'invalid_request_error' } });
        const locations = await listRegulationArticleLocations({ articleId: article.id });
        const sourceVersion = await getRegulationVersionStorageById(article.version_id, article.document_id);
        const baseUrl = `/api/apps/regulations/documents/${encodeURIComponent(article.document_id)}/versions/${encodeURIComponent(article.version_id)}`;
        res.json({
            article: { id: article.id, documentId: article.document_id, versionId: article.version_id },
            locations,
            source: sourceVersion ? {
                fileName: sourceVersion.source_name || '',
                isPdf: String(sourceVersion.source_format || '').toLowerCase() === 'pdf',
                downloadUrl: `${baseUrl}/source`,
                previewUrl: String(sourceVersion.source_format || '').toLowerCase() === 'pdf' ? `${baseUrl}/source-preview` : ''
            } : null
        });
    }));

    router.post('/articles/:articleId/annotations', authMiddleware, asyncHandler(async (req, res) => {
        const annotation = await createRegulationAnnotation({
            articleId: req.params.articleId,
            userId: req.user.id,
            content: req.body?.content,
            includeArchived: isAdmin(req.user)
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
            content: req.body?.content,
            includeArchived: isAdmin(req.user)
        });
        if (!annotation) {
            return res.status(403).json({ error: { message: '批注不存在或无权编辑', type: 'forbidden' } });
        }
        res.json({ annotation });
    }));

    router.delete('/annotations/:annotationId', authMiddleware, asyncHandler(async (req, res) => {
        const ok = await deleteRegulationAnnotation({
            annotationId: req.params.annotationId,
            userId: req.user.id,
            includeArchived: isAdmin(req.user)
        });
        if (!ok) {
            return res.status(403).json({ error: { message: '批注不存在或无权删除', type: 'forbidden' } });
        }
        res.json({ success: true });
    }));

    // #11 AI 回答导出为合规报告（Markdown / DOCX / PDF）
    router.post('/report', authMiddleware, asyncHandler(async (req, res) => {
        const body = req.body || {};
        const report = {
            question: body.question,
            answer: body.answer,
            sources: Array.isArray(body.sources) ? body.sources : []
        };
        const format = ['docx', 'pdf'].includes(String(body.format || '').toLowerCase()) ? String(body.format).toLowerCase() : 'md';
        logAction(req, '法规查询导出合规报告', `问题：${String(body.question || '').slice(0, 40)}`);
        if (format === 'md') return res.json({ markdown: buildRegulationQaReport(report), format });
        const rendered = await renderDocumentIr(buildRegulationQaReportIr(report), format);
        const extension = format === 'docx' ? 'docx' : 'pdf';
        res.json({
            format,
            fileName: `法规查询合规报告_${Date.now()}.${extension}`,
            mimeType: rendered.mimeType,
            contentBase64: rendered.buffer.toString('base64')
        });
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
            category: req.query.category || '',
            issuingBody: req.query.issuingBody || req.query.issuing_body || '',
            jurisdiction: req.query.jurisdiction || '',
            status: req.query.status || '',
            limit: req.query.limit,
            includeArchived: isAdmin(req.user) && req.query.includeArchived === 'true',
            userId: req.user.id
        });
        await recordRegulationAccess({
            userId: req.user.id,
            documentId: req.query.documentId || req.query.document_id,
            action: 'search_hybrid',
            detail: String(req.query.q || req.query.query || '').slice(0, 200)
        });
        if (res.headersSent || res.writableEnded) return;
        res.json({ matches });
    }));

    // #14 相似条文推荐
    router.get('/articles/:articleId/similar', authMiddleware, asyncHandler(async (req, res) => {
        const article = await getReadableRegulationArticle(req.params.articleId, { includeArchived: isAdmin(req.user) });
        if (!article) {
            if (!res.headersSent && !res.writableEnded) {
                res.status(404).json({ error: { message: '条文不存在或不可访问', type: 'invalid_request_error' } });
            }
            return;
        }
        const similar = await findSimilarRegulationArticles({
            articleId: req.params.articleId,
            limit: req.query.limit,
            includeArchived: isAdmin(req.user)
        });
        if (res.headersSent || res.writableEnded) return;
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
