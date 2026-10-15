const { asyncHandler } = require('../../../http');
const {
    fs,
    isAdmin,
    SUPPORTED_UPLOAD_LABEL,
    analyzeRegulationChangeImpact,
    approveHighConfidenceRegulationCitationLinks,
    cancelRegulationImportJob,
    cleanupTempUpload,
    cleanupTempUploads,
    countActualRegulationArticles,
    createRegulationDocumentFromUpload,
    createRegulationObligation,
    deleteRegulationBookmark,
    enqueueRegulationImportJob,
    deleteRegulationDocument,
    deleteRegulationDocuments,
    diffRegulationVersions,
    findRegulationDuplicateByHash,
    getRegulationCitationGraph,
    getRegulationIndexSummary,
    getRegulationDocumentById,
    getRegulationDocumentDetail,
    getRegulationVersionStorageById,
    hashUploadedFile,
    createRegulationCategory,
    deleteRegulationCategory,
    listRegulationDocuments,
    listRegulationCategoryFolders,
    listDeletedRegulationDocuments,
    listRegulationBookmarks,
    listRegulationDocumentChangeLogs,
    listRegulationAiAnswerLogs,
    listRegulationCitationGovernance,
    listRegulationFacets,
    listRegulationFolderDocumentSelection,
    listRegulationObligations,
    listRegulationAssignees,
    listRegulationQualitySummary,
    listRegulationSubscriptions,
    listRegulationImportJobs,
    normalizeRegulationId,
    parseRegulationArticles,
    prepareRegulationUploadMetadata,
    readRegulationMetadata,
    rebuildRegulationCrossLinks,
    rebuildRegulationArticleLocations,
    rebuildRegulationDocumentLocations,
    reindexRegulationDocuments,
    reviewRegulationCitationLinks,
    recordRegulationAccess,
    requestRegulationVersionReindex,
    queueRegulationLibraryReindex,
    retryRegulationImportJob,
    revertRegulationDocumentBatch,
    reviewRegulationObligation,
    requireRegulationsAdmin,
    requireRegulationsSuperAdmin,
    resolveRegulationVersionDownloadPath,
    restoreRegulationDocument,
    saveRegulationDocumentVersion,
    saveRegulationBookmark,
    startRegulationImportWorker,
    startRegulationIndexRecoveryRunner,
    triggerRegulationIndexRecovery,
    subscribeToRegulation,
    searchRegulationArticles,
    updateRegulationDocument,
    updateRegulationDocuments,
    updateRegulationVersionGovernance,
    unsubscribeFromRegulation
} = require('./helpers');

function registerDocumentRoutes(router, deps) {
    const { authMiddleware, logAction, uploadLimiter, upload } = deps;
    // 必须在 multer 落盘之前完成法规管理员鉴权；否则普通登录用户可用大 multipart
    // 请求占满临时磁盘，即便后续业务处理会返回 403。
    const requireRegulationsAdminBeforeUpload = (req, res, next) => {
        if (requireRegulationsAdmin(req, res)) next();
    };

    async function getReadableDocument(req, documentId) {
        return await getRegulationDocumentById(documentId, { includeArchived: isAdmin(req.user) });
    }

    async function resolveReadableVersionSource(req, documentId, versionId) {
        const document = await getReadableDocument(req, documentId);
        if (!document) return null;
        const version = await getRegulationVersionStorageById(versionId, document.id);
        if (!version) return null;
        const filePath = resolveRegulationVersionDownloadPath(version);
        const exists = filePath && await fs.promises.access(filePath).then(() => true).catch(() => false);
        return exists ? { document, version, filePath } : null;
    }

    router.get('/documents', authMiddleware, asyncHandler(async (req, res) => {
            const includeArchived = isAdmin(req.user) && req.query.includeArchived === 'true';
            const governancePending = req.query.governancePending === 'true' || req.query.governance_pending === 'true';
            const governanceScope = String(req.query.governanceScope || req.query.governance_scope || '').trim();
            if ((governancePending || governanceScope) && !requireRegulationsAdmin(req, res)) return;
            const result = await listRegulationDocuments({
                query: req.query.query || '',
                category: req.query.category || '',
                issuingBody: req.query.issuingBody || req.query.issuing_body || '',
                jurisdiction: req.query.jurisdiction || '',
                status: req.query.status || '',
                uncategorized: req.query.uncategorized === 'true',
                governancePending,
                governanceScope,
                includeArchived,
                limit: req.query.limit,
                offset: req.query.offset
            });
            res.json(result);
        }));

        router.get('/category-folders', authMiddleware, asyncHandler(async (req, res) => {
            const includeArchived = isAdmin(req.user) && req.query.includeArchived === 'true';
            res.json({ folders: await listRegulationCategoryFolders({ includeArchived }) });
        }));

        router.post('/category-folders', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsSuperAdmin(req, res, '仅 admin 权限层级可新建法规分类目录')) return;
            let body = req.body;
            if (typeof body === 'string') {
                try { body = JSON.parse(body); } catch (_) {}
            }
            const name = String(body?.name || '').trim();
            const description = String(body?.description || '').trim();
            const result = await createRegulationCategory({ name, description, userId: req.user.id });
            logAction(req, '法规查询创建分类目录', `分类：${name}`);
            res.status(201).json(result);
        }));

        router.delete('/category-folders/:category', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsSuperAdmin(req, res, '仅 admin 权限层级可删除法规分类目录')) return;
            const name = decodeURIComponent(req.params.category || '').trim();
            const result = await deleteRegulationCategory({ name });
            logAction(req, '法规查询删除分类目录', `分类：${name}`);
            res.json(result);
        }));

        router.get('/documents/folder-selection', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const includeArchived = isAdmin(req.user) && req.query.includeArchived === 'true';
            const governanceScope = String(req.query.governanceScope || req.query.governance_scope || '').trim();
            res.json(await listRegulationFolderDocumentSelection({
                category: req.query.category || '',
                uncategorized: req.query.uncategorized === 'true',
                governanceScope,
                includeArchived,
                limit: req.query.limit
            }));
        }));

        router.get('/recycle-bin', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsSuperAdmin(req, res)) return;
            res.json(await listDeletedRegulationDocuments({ limit: req.query.limit, offset: req.query.offset }));
        }));

        router.post('/recycle-bin/:id/restore', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsSuperAdmin(req, res)) return;
            const document = await restoreRegulationDocument({ documentId: req.params.id, userId: req.user.id });
            if (!document) {
                return res.status(404).json({ error: { message: '已删除法规不存在或已被恢复', type: 'invalid_request_error' } });
            }
            logAction(req, '法规查询恢复回收站文档', `文档 ${document.id}：${document.title}`);
            res.json({ document });
        }));
    
        router.get('/documents/search', authMiddleware, asyncHandler(async (req, res) => {
            const query = String(req.query.query || req.query.q || '').trim();
            const hasFilters = ['category', 'issuingBody', 'issuing_body', 'jurisdiction', 'status']
                .some(key => String(req.query[key] || '').trim());
            if (!query && !hasFilters) return res.json({ matches: [] });
            const includeArchived = isAdmin(req.user) && req.query.includeArchived === 'true';
            const documentId = normalizeRegulationId(req.query.documentId || req.query.document_id);
            const matches = await searchRegulationArticles({
                query,
                documentId,
                category: req.query.category || '',
                issuingBody: req.query.issuingBody || req.query.issuing_body || '',
                jurisdiction: req.query.jurisdiction || '',
                status: req.query.status || '',
                limit: req.query.limit,
                includeArchived
            });
            await recordRegulationAccess({ userId: req.user.id, documentId, action: 'search', detail: query.slice(0, 200) });
            if (res.headersSent || res.writableEnded) return;
            res.json({ matches });
        }));
    
        router.get('/facets', authMiddleware, asyncHandler(async (req, res) => {
            const includeArchived = isAdmin(req.user) && req.query.includeArchived === 'true';
            const facets = await listRegulationFacets({ includeArchived });
            res.json(facets);
        }));

        router.get('/quality-summary', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            res.json({ summary: await listRegulationQualitySummary() });
        }));

        router.get('/assignees', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            res.json({ assignees: await listRegulationAssignees() });
        }));

        router.get('/citation-governance', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            res.json(await listRegulationCitationGovernance({
                type: req.query.type,
                limit: req.query.limit,
                offset: req.query.offset
            }));
        }));

        router.put('/citation-governance/review', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const result = await reviewRegulationCitationLinks({
                linkIds: req.body?.ids || req.body?.linkIds || req.body?.link_ids,
                reviewStatus: req.body?.reviewStatus || req.body?.review_status
            });
            if (!result.ids.length || !result.reviewStatus) {
                return res.status(400).json({ error: { message: '请选择要处理的引用，并指定审核结论', type: 'invalid_request_error' } });
            }
            logAction(req, '法规查询审核引用关系', `结论 ${result.reviewStatus}，处理 ${result.updated} 条`);
            res.json({ result });
        }));

        router.post('/citation-governance/approve-high-confidence', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const result = await approveHighConfidenceRegulationCitationLinks({
                minConfidence: req.body?.minConfidence || req.body?.min_confidence,
                limit: req.body?.limit
            });
            logAction(req, '法规查询批量确认高置信引用', `阈值 ${result.minConfidence}，确认 ${result.updated} / 候选 ${result.candidates}`);
            res.json({ result });
        }));

        router.get('/subscriptions', authMiddleware, asyncHandler(async (req, res) => {
            const subscriptions = await listRegulationSubscriptions({ userId: req.user.id, documentId: req.query.documentId || req.query.document_id });
            res.json({ subscriptions });
        }));

        router.get('/bookmarks', authMiddleware, asyncHandler(async (req, res) => {
            const documentId = normalizeRegulationId(req.query.documentId || req.query.document_id);
            if (documentId && !(await getReadableDocument(req, documentId))) {
                return res.status(404).json({ error: { message: '法规文档不存在或不可访问', type: 'invalid_request_error' } });
            }
            res.json({ bookmarks: await listRegulationBookmarks({ userId: req.user.id, documentId }) });
        }));

        router.post('/documents/:id/bookmarks', authMiddleware, asyncHandler(async (req, res) => {
            if (!(await getReadableDocument(req, req.params.id))) {
                return res.status(404).json({ error: { message: '法规文档不存在或不可访问', type: 'invalid_request_error' } });
            }
            const bookmark = await saveRegulationBookmark({
                userId: req.user.id,
                documentId: req.params.id,
                topic: req.body?.topic,
                note: req.body?.note
            });
            res.json({ bookmark });
        }));

        router.delete('/bookmarks/:bookmarkId', authMiddleware, asyncHandler(async (req, res) => {
            const success = await deleteRegulationBookmark({ bookmarkId: req.params.bookmarkId, userId: req.user.id });
            if (!success) {
                return res.status(404).json({ error: { message: '收藏不存在或无权取消', type: 'invalid_request_error' } });
            }
            res.json({ success: true });
        }));

        router.get('/ai-logs', authMiddleware, asyncHandler(async (req, res) => {
            const documentId = normalizeRegulationId(req.query.documentId || req.query.document_id);
            if (documentId && !(await getReadableDocument(req, documentId))) {
                return res.status(404).json({ error: { message: '法规文档不存在或不可访问', type: 'invalid_request_error' } });
            }
            res.json(await listRegulationAiAnswerLogs({
                userId: req.user.id,
                documentId,
                limit: req.query.limit,
                offset: req.query.offset
            }));
        }));

        router.post('/documents/:id/subscriptions', authMiddleware, asyncHandler(async (req, res) => {
            if (!(await getReadableDocument(req, req.params.id))) {
                return res.status(404).json({ error: { message: '法规文档不存在或不可访问', type: 'invalid_request_error' } });
            }
            const subscription = await subscribeToRegulation({
                userId: req.user.id,
                documentId: req.params.id,
                approvedOnly: req.body?.approvedOnly !== false
            });
            res.json({ subscription });
        }));

        router.delete('/documents/:id/subscriptions', authMiddleware, asyncHandler(async (req, res) => {
            const ok = await unsubscribeFromRegulation({ userId: req.user.id, documentId: req.params.id });
            res.json({ success: ok });
        }));
    
        router.get('/documents/:id', authMiddleware, asyncHandler(async (req, res) => {
            const includeArchived = isAdmin(req.user);
            const detail = await getRegulationDocumentDetail(req.params.id, {
                versionId: req.query.versionId || req.query.version_id,
                effectiveAt: req.query.effectiveAt || req.query.effective_at || '',
                includeArchived
            });
            if (!detail || (!includeArchived && detail.document.status === 'archived')) {
                return res.status(404).json({ error: { message: '法规文档不存在或已归档', type: 'invalid_request_error' } });
            }
            await recordRegulationAccess({ userId: req.user.id, documentId: detail.document.id, action: 'view', detail: detail.document.title });
            res.json({ detail });
        }));
    
        router.get('/documents/:id/diff', authMiddleware, asyncHandler(async (req, res) => {
            if (!(await getReadableDocument(req, req.params.id))) {
                return res.status(404).json({ error: { message: '法规文档不存在或不可访问', type: 'invalid_request_error' } });
            }
            const fromVersionId = normalizeRegulationId(req.query.from);
            const toVersionId = normalizeRegulationId(req.query.to);
            if (!fromVersionId || !toVersionId) {
                return res.status(400).json({ error: { message: '需要提供 from 和 to 版本 ID', type: 'invalid_request_error' } });
            }
            try {
                const diff = await diffRegulationVersions({ documentId: req.params.id, fromVersionId, toVersionId, includeArchived: isAdmin(req.user) });
                logAction(req, '法规查询版本对比', `${diff.document.title} (v${diff.from.id} → v${diff.to.id})`);
                res.json({ diff });
            } catch (error) {
                res.status(404).json({ error: { message: error.message || '版本对比失败', type: 'not_found' } });
            }
        }));
    
        router.get('/documents/:id/change-impact', authMiddleware, asyncHandler(async (req, res) => {
            if (!(await getReadableDocument(req, req.params.id))) {
                return res.status(404).json({ error: { message: '法规文档不存在或不可访问', type: 'invalid_request_error' } });
            }
            const fromVersionId = normalizeRegulationId(req.query.from);
            const toVersionId = normalizeRegulationId(req.query.to);
            if (!fromVersionId || !toVersionId) {
                return res.status(400).json({ error: { message: '需要提供 from 和 to 版本 ID', type: 'invalid_request_error' } });
            }
            try {
                const impact = await analyzeRegulationChangeImpact({ documentId: req.params.id, fromVersionId, toVersionId, includeArchived: isAdmin(req.user) });
                res.json({ impact });
            } catch (error) {
                res.status(404).json({ error: { message: error.message || '影响分析失败', type: 'not_found' } });
            }
        }));
    
        router.get('/documents/:id/citation-graph', authMiddleware, asyncHandler(async (req, res) => {
            if (!(await getReadableDocument(req, req.params.id))) {
                return res.status(404).json({ error: { message: '法规文档不存在或不可访问', type: 'invalid_request_error' } });
            }
            const graph = await getRegulationCitationGraph(req.params.id, {
                versionId: req.query.versionId || req.query.version_id,
                effectiveAt: req.query.effectiveAt || req.query.effective_at || '',
                includeArchived: isAdmin(req.user)
            });
            res.json({ graph });
        }));

        router.get('/documents/:id/obligations', authMiddleware, asyncHandler(async (req, res) => {
            if (!(await getReadableDocument(req, req.params.id))) {
                return res.status(404).json({ error: { message: '法规文档不存在或不可访问', type: 'invalid_request_error' } });
            }
            const obligations = await listRegulationObligations({
                documentId: req.params.id,
                articleId: req.query.articleId || req.query.article_id,
                includeArchived: isAdmin(req.user)
            });
            const assignees = isAdmin(req.user) ? await listRegulationAssignees() : [];
            res.json({ obligations, assignees });
        }));

        router.post('/documents/:id/versions/:versionId/articles/:articleId/obligations', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const detail = await getRegulationDocumentDetail(req.params.id, { versionId: req.params.versionId, includeArchived: true });
            const article = detail?.articles?.find(item => Number(item.id) === Number(normalizeRegulationId(req.params.articleId)));
            if (!detail || !article) {
                return res.status(404).json({ error: { message: '法规版本或条文不存在', type: 'invalid_request_error' } });
            }
            const obligation = await createRegulationObligation({
                userId: req.user.id,
                documentId: req.params.id,
                versionId: req.params.versionId,
                articleId: req.params.articleId,
                input: req.body || {}
            });
            if (!obligation) {
                return res.status(400).json({ error: { message: '义务事项必须填写要求动作', type: 'invalid_request_error' } });
            }
            logAction(req, '法规查询新增合规义务', `文档 ${req.params.id}，条文 ${req.params.articleId}`);
            res.json({ obligation });
        }));

        router.put('/documents/:id/obligations/:obligationId/review', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            if (!(await getReadableDocument(req, req.params.id))) {
                return res.status(404).json({ error: { message: '法规文档不存在或不可访问', type: 'invalid_request_error' } });
            }
            const obligation = await reviewRegulationObligation({
                obligationId: req.params.obligationId,
                documentId: req.params.id,
                userId: req.user.id,
                input: req.body || {}
            });
            if (!obligation) {
                return res.status(400).json({ error: { message: '义务不存在，或审核状态不合法', type: 'invalid_request_error' } });
            }
            logAction(req, '法规查询审核合规义务', `文档 ${req.params.id}，义务 ${req.params.obligationId} → ${obligation.review_status}`);
            res.json({ obligation });
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
            const sourceVersion = await getRegulationVersionStorageById(currentVer.id, detail.document.id);
            if (!sourceVersion) {
                return res.status(404).json({ error: { message: '法规源文件不存在', type: 'not_found' } });
            }
            const filePath = resolveRegulationVersionDownloadPath(sourceVersion);
            if (!filePath || !await fs.promises.access(filePath).then(() => true).catch(() => false)) {
                return res.status(404).json({ error: { message: '源文件已被移动或删除', type: 'not_found' } });
            }
            await recordRegulationAccess({ userId: req.user.id, documentId: detail.document.id, action: 'download', detail: detail.document.title });
            res.download(filePath, sourceVersion.source_name || `${detail.document.title}.txt`);
        }));

        // 原页追溯使用版本级受控文件路由，不向客户端返回服务器源路径。
        router.get('/documents/:id/versions/:versionId/source', authMiddleware, asyncHandler(async (req, res) => {
            const source = await resolveReadableVersionSource(req, req.params.id, req.params.versionId);
            if (!source) {
                return res.status(404).json({ error: { message: '法规版本源文件不存在或不可访问', type: 'not_found' } });
            }
            await recordRegulationAccess({ userId: req.user.id, documentId: source.document.id, action: 'source_download', detail: source.version.source_name || source.document.title });
            res.download(source.filePath, source.version.source_name || `${source.document.title}.txt`);
        }));

        router.get('/documents/:id/versions/:versionId/source-preview', authMiddleware, asyncHandler(async (req, res) => {
            const source = await resolveReadableVersionSource(req, req.params.id, req.params.versionId);
            if (!source) {
                return res.status(404).json({ error: { message: '法规版本源文件不存在或不可访问', type: 'not_found' } });
            }
            if (String(source.version.source_format || '').toLowerCase() !== 'pdf') {
                return res.status(415).json({ error: { message: '仅 PDF 源文件支持页内预览，请下载原文件查看', type: 'invalid_request_error' } });
            }
            await recordRegulationAccess({ userId: req.user.id, documentId: source.document.id, action: 'source_preview', detail: source.version.source_name || source.document.title });
            res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(source.version.source_name || 'regulation.pdf')}"`);
            res.type('application/pdf');
            res.sendFile(source.filePath);
        }));
    
        router.post('/documents/batch', authMiddleware, requireRegulationsAdminBeforeUpload, uploadLimiter, upload.array('file', 300), asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) {
                await cleanupTempUploads(req.files);
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
                    const duplicateOf = await findRegulationDuplicateByHash(await hashUploadedFile(file));
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
                    await cleanupTempUpload(file);
                }
            }
            logAction(req, '法规查询批量导入', `成功 ${created.length} / 共 ${files.length}${failed.length ? `，失败 ${failed.length}` : ''}`);
            res.json({
                total: files.length,
                created,
                failed
            });
        }));

        router.get('/import-jobs', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const result = await listRegulationImportJobs({
                userId: req.user.id,
                status: req.query.status,
                limit: req.query.limit,
                offset: req.query.offset
            });
            res.json(result);
        }));

        router.post('/import-jobs/:jobId/retry', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const job = await retryRegulationImportJob({ jobId: req.params.jobId, userId: req.user.id });
            if (!job) {
                return res.status(409).json({ error: { message: '仅失败或已取消的本人导入任务可以重新提交', type: 'invalid_request_error' } });
            }
            await startRegulationImportWorker();
            logAction(req, '法规查询重试导入任务', `任务 ${job.id}`);
            res.status(202).json({ job });
        }));

        router.delete('/import-jobs/:jobId', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const job = await cancelRegulationImportJob({ jobId: req.params.jobId, userId: req.user.id });
            if (!job) {
                return res.status(409).json({ error: { message: '仅排队或等待重试的本人导入任务可以取消', type: 'invalid_request_error' } });
            }
            logAction(req, '法规查询取消导入任务', `任务 ${job.id}`);
            res.json({ job });
        }));

        router.post('/documents/import-jobs', authMiddleware, requireRegulationsAdminBeforeUpload, uploadLimiter, upload.array('file', 300), asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) {
                await cleanupTempUploads(req.files);
                return;
            }
            const files = Array.isArray(req.files) ? req.files : [];
            if (!files.length) {
                return res.status(400).json({ error: { message: `请选择要导入的法规文档，支持 ${SUPPORTED_UPLOAD_LABEL}`, type: 'invalid_request_error' } });
            }
            const metadata = readRegulationMetadata(req.body || {});
            const duplicateAction = String(req.body?.duplicateAction || req.body?.duplicate_action || 'continue').trim().toLowerCase() === 'skip' ? 'skip' : 'continue';
            const jobs = [];
            const failed = [];
            const skipped = [];
            for (const file of files) {
                try {
                    const duplicateOf = await findRegulationDuplicateByHash(await hashUploadedFile(file));
                    if (duplicateAction === 'skip' && duplicateOf) {
                        skipped.push({ fileName: file.originalname || '', duplicateOf });
                        await cleanupTempUpload(file);
                        continue;
                    }
                    jobs.push(await enqueueRegulationImportJob({ userId: req.user.id, file, metadata }));
                } catch (error) {
                    failed.push({ fileName: file.originalname || '', message: error.message || '导入任务创建失败' });
                    await cleanupTempUpload(file);
                }
            }
            if (jobs.length) await startRegulationImportWorker();
            logAction(req, '法规查询提交导入任务', `已提交 ${jobs.length} / 共 ${files.length}${skipped.length ? `，跳过重复 ${skipped.length}` : ''}${failed.length ? `，失败 ${failed.length}` : ''}`);
            res.status(202).json({ total: files.length, jobs, failed, skipped });
        }));
    
        router.post('/documents', authMiddleware, requireRegulationsAdminBeforeUpload, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) {
                await cleanupTempUpload(req.file);
                return;
            }
            if (!req.file) {
                return res.status(400).json({ error: { message: `请选择要导入的法规文档，支持 ${SUPPORTED_UPLOAD_LABEL}`, type: 'invalid_request_error' } });
            }
            try {
                const duplicateOf = await findRegulationDuplicateByHash(await hashUploadedFile(req.file));
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
                await cleanupTempUpload(req.file);
                throw error;
            }
        }));
    
        // #7 导入前预览：只解析不落库，返回切出的条文列表供管理员校正
        router.post('/documents/preview', authMiddleware, requireRegulationsAdminBeforeUpload, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) {
                await cleanupTempUpload(req.file);
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
                await cleanupTempUpload(req.file);
            }
        }));
    
        router.post('/documents/:id/versions', authMiddleware, requireRegulationsAdminBeforeUpload, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) {
                await cleanupTempUpload(req.file);
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
                await cleanupTempUpload(req.file);
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

        router.put('/documents/:id/versions/:versionId/governance', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const version = await updateRegulationVersionGovernance({
                documentId: req.params.id,
                versionId: req.params.versionId,
                userId: req.user.id,
                patch: req.body || {}
            });
            if (!version) {
                return res.status(404).json({ error: { message: '法规版本不存在或已删除', type: 'invalid_request_error' } });
            }
            logAction(req, '法规查询更新版本治理信息', `文档 ${req.params.id}，版本 ${req.params.versionId}`);
            res.json({ version });
        }));

        router.post('/documents/:id/versions/:versionId/reindex', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const version = await requestRegulationVersionReindex({
                documentId: req.params.id,
                versionId: req.params.versionId,
                userId: req.user.id
            });
            if (!version) {
                return res.status(404).json({ error: { message: '法规版本不存在或不可重新建立索引', type: 'invalid_request_error' } });
            }
            await startRegulationIndexRecoveryRunner();
            void triggerRegulationIndexRecovery();
            logAction(req, '法规查询重新建立向量索引', `文档 ${req.params.id}，版本 ${req.params.versionId}`);
            res.status(202).json({ version });
        }));

        router.post('/documents/:id/versions/:versionId/rebuild-locations', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const result = await rebuildRegulationArticleLocations({
                documentId: req.params.id,
                versionId: req.params.versionId
            });
            if (!result) {
                return res.status(404).json({ error: { message: '法规版本不存在或不可生成来源定位', type: 'invalid_request_error' } });
            }
            logAction(req, '法规查询重建条文来源定位', `文档 ${req.params.id}，版本 ${req.params.versionId}，定位 ${result.rebuilt} 条`);
            res.json({ result });
        }));

        router.post('/documents/batch-reindex', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const result = await reindexRegulationDocuments({ documentIds: req.body?.ids || req.body?.documentIds || req.body?.document_ids });
            await startRegulationIndexRecoveryRunner();
            void triggerRegulationIndexRecovery();
            logAction(req, '法规查询批量重建选中向量索引', `成功排队 ${result.queuedVersions} / 选中 ${result.total}，失败 ${result.failed.length}`);
            res.status(202).json({ result });
        }));

        router.post('/documents/batch-rebuild-locations', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const result = await rebuildRegulationDocumentLocations({ documentIds: req.body?.ids || req.body?.documentIds || req.body?.document_ids });
            logAction(req, '法规查询批量重建条文来源定位', `成功 ${result.rebuilt.length} / 选中 ${result.total}，定位 ${result.rebuiltArticles} 条，失败 ${result.failed.length}`);
            res.json({ result });
        }));

        router.get('/index-summary', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            res.json({ summary: await getRegulationIndexSummary() });
        }));

        router.post('/documents/reindex', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const result = await queueRegulationLibraryReindex({
                category: req.body?.category,
                uncategorized: req.body?.uncategorized === true || req.body?.uncategorized === 'true'
            });
            await startRegulationIndexRecoveryRunner();
            void triggerRegulationIndexRecovery();
            const scope = result.scope === 'all' ? '全库' : (result.scope === 'uncategorized' ? '未分类' : `分类：${result.scope}`);
            logAction(req, '法规查询批量重建向量索引', `${scope}，已排队 ${result.queuedVersions} 个当前版本，清空 ${result.clearedArticles} 条旧向量`);
            res.status(202).json({ result });
        }));
    
        router.post('/documents/batch-update', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const result = await updateRegulationDocuments({
                documentIds: req.body?.ids,
                userId: req.user.id,
                patch: req.body?.patch
            });
            logAction(req, '法规查询批量修改信息', `字段：${result.fields.join('、')}，成功 ${result.updated.length} / 共 ${result.total}，失败 ${result.failed.length}`);
            res.json(result);
        }));

        router.get('/documents/batch-change-logs', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const batchId = String(req.query.batchId || req.query.batch_id || '').trim();
            if (!batchId) return res.status(400).json({ error: { message: '需要提供批量修改记录 ID', type: 'invalid_request_error' } });
            res.json({ logs: await listRegulationDocumentChangeLogs({ batchId }) });
        }));

        router.post('/documents/batch-revert', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsAdmin(req, res)) return;
            const batchId = String(req.body?.batchId || req.body?.batch_id || '').trim();
            if (!batchId) return res.status(400).json({ error: { message: '需要提供批量修改记录 ID', type: 'invalid_request_error' } });
            const result = await revertRegulationDocumentBatch({ batchId, userId: req.user.id });
            logAction(req, '法规查询撤销批量修改', `撤销 ${result.reverted.length} 项，未撤销 ${result.failed.length} 项`);
            res.json(result);
        }));

        router.post('/documents/batch-delete', authMiddleware, asyncHandler(async (req, res) => {
            if (!requireRegulationsSuperAdmin(req, res)) return;
            const result = await deleteRegulationDocuments({
                documentIds: req.body?.ids,
                userId: req.user.id
            });
            logAction(req, '法规查询批量删除', `成功 ${result.deleted.length} / 共 ${result.total}，失败 ${result.failed.length}`);
            res.json(result);
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
