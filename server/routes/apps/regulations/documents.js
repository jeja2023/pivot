const { asyncHandler } = require('../../../http');
const {
    fs,
    isAdmin,
    SUPPORTED_UPLOAD_LABEL,
    analyzeRegulationChangeImpact,
    cleanupTempUpload,
    cleanupTempUploads,
    countActualRegulationArticles,
    createRegulationDocumentFromUpload,
    deleteRegulationDocument,
    diffRegulationVersions,
    findRegulationDuplicateByHash,
    getRegulationCitationGraph,
    getRegulationDocumentDetail,
    hashUploadedFile,
    listRegulationDocuments,
    listRegulationFacets,
    normalizeRegulationId,
    parseRegulationArticles,
    prepareRegulationUploadMetadata,
    readRegulationMetadata,
    rebuildRegulationCrossLinks,
    recordRegulationAccess,
    requireRegulationsAdmin,
    requireRegulationsSuperAdmin,
    resolveRegulationVersionDownloadPath,
    saveRegulationDocumentVersion,
    searchRegulationArticles,
    updateRegulationDocument
} = require('./helpers');

function registerDocumentRoutes(router, deps) {
    const { authMiddleware, logAction, uploadLimiter, upload } = deps;

    router.get('/documents', authMiddleware, asyncHandler(async (req, res) => {
            const includeArchived = isAdmin(req.user) && req.query.includeArchived === 'true';
            const result = await listRegulationDocuments({
                query: req.query.query || '',
                category: req.query.category || '',
                jurisdiction: req.query.jurisdiction || '',
                status: req.query.status || '',
                includeArchived,
                limit: req.query.limit,
                offset: req.query.offset
            });
            res.json(result);
        }));
    
        router.get('/documents/search', authMiddleware, asyncHandler(async (req, res) => {
            const query = String(req.query.query || req.query.q || '').trim();
            if (!query) return res.json({ matches: [] });
            const includeArchived = isAdmin(req.user) && req.query.includeArchived === 'true';
            const documentId = normalizeRegulationId(req.query.documentId || req.query.document_id);
            const matches = await searchRegulationArticles({
                query,
                documentId,
                limit: req.query.limit,
                includeArchived
            });
            res.json({ matches });
        }));
    
        router.get('/facets', authMiddleware, asyncHandler(async (req, res) => {
            const includeArchived = isAdmin(req.user) && req.query.includeArchived === 'true';
            const facets = await listRegulationFacets({ includeArchived });
            res.json(facets);
        }));
    
        router.get('/documents/:id', authMiddleware, asyncHandler(async (req, res) => {
            const includeArchived = isAdmin(req.user);
            const detail = await getRegulationDocumentDetail(req.params.id, {
                versionId: req.query.versionId || req.query.version_id,
                includeArchived
            });
            if (!detail || (!includeArchived && detail.document.status === 'archived')) {
                return res.status(404).json({ error: { message: '法规文档不存在或已归档', type: 'invalid_request_error' } });
            }
            await recordRegulationAccess({ userId: req.user.id, documentId: detail.document.id, action: 'view', detail: detail.document.title });
            res.json({ detail });
        }));
    
        router.get('/documents/:id/diff', authMiddleware, asyncHandler(async (req, res) => {
            const fromVersionId = normalizeRegulationId(req.query.from);
            const toVersionId = normalizeRegulationId(req.query.to);
            if (!fromVersionId || !toVersionId) {
                return res.status(400).json({ error: { message: '需要提供 from 和 to 版本 ID', type: 'invalid_request_error' } });
            }
            try {
                const diff = await diffRegulationVersions({ documentId: req.params.id, fromVersionId, toVersionId });
                logAction(req, '法规查询版本对比', `${diff.document.title} (v${diff.from.id} → v${diff.to.id})`);
                res.json({ diff });
            } catch (error) {
                res.status(404).json({ error: { message: error.message || '版本对比失败', type: 'not_found' } });
            }
        }));
    
        router.get('/documents/:id/change-impact', authMiddleware, asyncHandler(async (req, res) => {
            const fromVersionId = normalizeRegulationId(req.query.from);
            const toVersionId = normalizeRegulationId(req.query.to);
            if (!fromVersionId || !toVersionId) {
                return res.status(400).json({ error: { message: '需要提供 from 和 to 版本 ID', type: 'invalid_request_error' } });
            }
            try {
                const impact = await analyzeRegulationChangeImpact({ documentId: req.params.id, fromVersionId, toVersionId });
                res.json({ impact });
            } catch (error) {
                res.status(404).json({ error: { message: error.message || '影响分析失败', type: 'not_found' } });
            }
        }));
    
        router.get('/documents/:id/citation-graph', authMiddleware, asyncHandler(async (req, res) => {
            const graph = await getRegulationCitationGraph(req.params.id, {
                versionId: req.query.versionId || req.query.version_id
            });
            res.json({ graph });
        }));
    
        router.post('/cross-links/rebuild', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const documentId = req.body?.documentId || req.body?.document_id || null;
            const result = await rebuildRegulationCrossLinks(documentId);
            logAction(req, '法规查询重建跨法关联', `回连 ${result.resolved} 条 / 共 ${result.versions} 版本`);
            res.json(result);
        }));
    
        router.get('/documents/:id/download', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const includeArchived = isAdmin(req.user);
            const detail = await getRegulationDocumentDetail(req.params.id, {
                versionId: req.query.versionId || req.query.version_id,
                includeArchived
            });
            if (!detail || (!includeArchived && detail.document.status === 'archived')) {
                return res.status(404).json({ error: { message: '法规源文件不存在', type: 'invalid_request_error' } });
            }
            const currentVer = detail.currentVersion || detail.version;
            if (!currentVer) {
                return res.status(404).json({ error: { message: '法规源文件不存在', type: 'invalid_request_error' } });
            }
            const filePath = resolveRegulationVersionDownloadPath(currentVer);
            if (!filePath || !fs.existsSync(filePath)) {
                return res.status(404).json({ error: { message: '源文件已被移动或删除', type: 'not_found' } });
            }
            await recordRegulationAccess({ userId: req.user.id, documentId: detail.document.id, action: 'download', detail: detail.document.title });
            res.download(filePath, currentVer.source_name || `${detail.document.title}.txt`);
        }));
    
        router.post('/documents/batch', authMiddleware, uploadLimiter, upload.array('file', 300), asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) {
                cleanupTempUploads(req.files);
                return;
            }
            const files = Array.isArray(req.files) ? req.files : [];
            if (!files.length) {
                return res.status(400).json({ error: { message: `请选择要导入的法规文档，支持 ${SUPPORTED_UPLOAD_LABEL}`, type: 'invalid_request_error' } });
            }
            const sharedMetadata = readRegulationMetadata(req.body || {});
            const created = [];
            const failed = [];
            for (const file of files) {
                try {
                    const duplicateOf = await findRegulationDuplicateByHash(hashUploadedFile(file));
                    const prepared = await prepareRegulationUploadMetadata(file, sharedMetadata);
                    const result = await createRegulationDocumentFromUpload({
                        userId: req.user.id,
                        file,
                        metadata: prepared,
                        preloadedText: prepared.extractedText
                    });
                    created.push({
                        document: result.document ? { id: result.document.id, title: result.document.title } : null,
                        version: result.version ? { id: result.version.id, version_label: result.version.version_label } : null,
                        summary: result.summary || '',
                        sourceName: file.originalname || '',
                        duplicateOf: duplicateOf || null
                    });
                } catch (error) {
                    failed.push({
                        fileName: file.originalname || '',
                        message: error.message || '导入失败'
                    });
                    cleanupTempUpload(file);
                }
            }
            logAction(req, '法规查询批量导入', `成功 ${created.length} / 共 ${files.length}${failed.length ? `，失败 ${failed.length}` : ''}`);
            res.json({
                total: files.length,
                created,
                failed
            });
        }));
    
        router.post('/documents', authMiddleware, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) {
                cleanupTempUpload(req.file);
                return;
            }
            if (!req.file) {
                return res.status(400).json({ error: { message: `请选择要导入的法规文档，支持 ${SUPPORTED_UPLOAD_LABEL}`, type: 'invalid_request_error' } });
            }
            try {
                const duplicateOf = await findRegulationDuplicateByHash(hashUploadedFile(req.file));
                const prepared = await prepareRegulationUploadMetadata(req.file, readRegulationMetadata(req.body || {}));
                const result = await createRegulationDocumentFromUpload({
                    userId: req.user.id,
                    file: req.file,
                    metadata: prepared,
                    preloadedText: prepared.extractedText
                });
                logAction(req, '法规查询导入文档', `文档：${result.document?.title || req.file.originalname}`);
                res.json({
                    document: result.document,
                    version: result.version,
                    articles: result.articles,
                    duplicateOf: duplicateOf || null,
                    summary: result.summary
                });
            } catch (error) {
                cleanupTempUpload(req.file);
                throw error;
            }
        }));
    
        // #7 导入前预览：只解析不落库，返回切出的条文列表供管理员校正
        router.post('/documents/preview', authMiddleware, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) {
                cleanupTempUpload(req.file);
                return;
            }
            if (!req.file) {
                return res.status(400).json({ error: { message: `请选择要预览的法规文档，支持 ${SUPPORTED_UPLOAD_LABEL}`, type: 'invalid_request_error' } });
            }
            try {
                const prepared = await prepareRegulationUploadMetadata(req.file, readRegulationMetadata(req.body || {}));
                const articles = parseRegulationArticles(prepared.extractedText || '', { docTitle: prepared.title });
                res.json({
                    title: prepared.title || '',
                    articleCount: countActualRegulationArticles(articles),
                    articles: articles.map((a, i) => ({
                        index: i,
                        articleLabel: a.articleLabel,
                        articleTitle: a.articleTitle,
                        headingPath: a.headingPath || '',
                        content: a.content
                    }))
                });
            } finally {
                cleanupTempUpload(req.file);
            }
        }));
    
        router.post('/documents/:id/versions', authMiddleware, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) {
                cleanupTempUpload(req.file);
                return;
            }
            if (!req.file) {
                return res.status(400).json({ error: { message: '请选择要上传的新版本文件', type: 'invalid_request_error' } });
            }
            try {
                const prepared = await prepareRegulationUploadMetadata(req.file, readRegulationMetadata(req.body || {}));
                const result = await saveRegulationDocumentVersion({
                    documentId: req.params.id,
                    userId: req.user.id,
                    file: req.file,
                    metadata: prepared,
                    providedTitle: req.body?.title || req.body?.name || prepared.title || '',
                    preloadedText: prepared.extractedText
                });
                logAction(req, '法规查询追加版本', `文档：${result.document?.title || req.params.id}`);
                res.json({
                    document: result.document,
                    version: result.version,
                    articles: result.articles,
                    summary: result.summary
                });
            } catch (error) {
                cleanupTempUpload(req.file);
                throw error;
            }
        }));
    
        router.put('/documents/:id', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const updated = await updateRegulationDocument({
                documentId: req.params.id,
                userId: req.user.id,
                patch: req.body || {}
            });
            if (!updated) {
                return res.status(404).json({ error: { message: '法规文档不存在或已归档', type: 'invalid_request_error' } });
            }
            logAction(req, '法规查询更新信息', `文档：${updated.title}`);
            res.json({ document: updated });
        }));
    
        router.delete('/documents/:id', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsSuperAdmin(req, res)) return;
            const deleted = await deleteRegulationDocument({
                documentId: req.params.id,
                userId: req.user.id
            });
            if (!deleted) {
                return res.status(404).json({ error: { message: '法规文档不存在或已归档', type: 'invalid_request_error' } });
            }
            logAction(req, '法规查询归档文档', `文档 ID：${req.params.id}`);
            res.json({ success: true });
        }));
    
}

module.exports = {
    registerDocumentRoutes
};
