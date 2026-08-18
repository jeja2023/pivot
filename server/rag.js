/* 知识库与 RAG API 门面 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { query, queryOne, execute } = require('./db/client');
const { groupConcat } = require('./db/dialect');
const { authMiddleware } = require('./auth');
const { asyncHandler, getClientIp } = require('./http');
const { getBeijingTimestamp } = require('./time');
const { createKnowledgeUploadMiddleware, normalizeUploadedOriginalName, uploadSecurityMiddleware } = require('./upload');
const { clearRagCacheForUser } = require('./services/rag-cache');
const {
    batchDeleteKnowledgeDocuments,
    batchReindexKnowledgeDocuments,
    createKnowledgeCollection,
    createKnowledgeTag,
    createKnowledgeDocumentFromUpload,
    deleteKnowledgeDocument,
    listKnowledgeCollections,
    listKnowledgeTags,
    getKnowledgeDocumentAuditList,
    getKnowledgeDocumentDetail,
    getKnowledgeDocumentForUser,
    getKnowledgeQualityReport,
    getKnowledgeDocumentSummaryForUser,
    getKnowledgeIndexQueueStatus,
    getRagFeedbackSummary,
    recordRagFeedback,
    scheduleFailedKnowledgeDocumentsForUser,
    scheduleKnowledgeDocumentIndexing,
    setKnowledgeDocumentCollection,
    setKnowledgeDocumentTags,
    setKnowledgeDocumentEnabled
} = require('./services/rag-documents');
const { buildDocumentAccessFilter, canReadKnowledgeResource } = require('./services/knowledge-access');
const {
    getKnowledgeCollectionShareOptions,
    updateKnowledgeCollectionSharing
} = require('./services/rag-documents');
const {
    retrieveContext,
    cosineSimilarity,
    chunkText,
    testEmbeddingConnection,
    debugRetrieveContext
} = require('./services/rag-index');
const { getEmbeddingConfig } = require('./services/rag-config');
const {
    confirmRelation,
    deleteRelation,
    getEntityGraph,
    getGraphSummaryAsync,
    listEntities,
    listRelations,
    mergeEntities,
    queryKnowledgeGraph,
    rebuildGraphForDocument,
    updateEntity,
    updateRelation
} = require('./services/knowledge-graph');
const { normalizeAuditAction } = require('./audit-actions');
const { isSuperAdmin } = require('./permissions');
const { listRagDebugQueries, recordRagDebugQuery } = require('./services/rag-debug-history');
const { recordObservabilityEvent, recordSlowRagRetrieval } = require('./services/observability');

const ragRouter = express.Router();
const debugQueryLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '召回测试请求过于频繁，请稍后再试' }
});
const upload = createKnowledgeUploadMiddleware();

function auditRagAction(req, action, details) {
    execute('INSERT INTO audit_logs (user_id, action, details, ip_address, timestamp) VALUES (?, ?, ?, ?, ?)', [
        req.user?.id || null,
        normalizeAuditAction(action),
        JSON.stringify(details || {}),
        getClientIp(req),
        getBeijingTimestamp()
    ]).catch(e => {
        req.log?.warn({ err: e.message, action }, 'RAG 审计日志写入失败');
    });
}

ragRouter.get('/docs', authMiddleware, asyncHandler(async (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 100);
    const offset = (page - 1) * limit;
    const collectionId = Number.parseInt(req.query.collectionId, 10);
    const tag = String(req.query.tag || '').trim().replace(/^#+/, '').slice(0, 40);
    const access = buildDocumentAccessFilter(req.user, 'd', 'c');
    const filters = [access.sql, 'd.deleted_at IS NULL'];
    const params = [...access.params];
    if (Number.isSafeInteger(collectionId) && collectionId > 0) {
        filters.push('d.collection_id = ?');
        params.push(collectionId);
    }
    if (tag) {
        filters.push('EXISTS (SELECT 1 FROM knowledge_doc_tags ft WHERE ft.doc_id = d.id AND ft.user_id = d.user_id AND ft.tag = ?)');
        params.push(tag);
    }
    const whereSql = filters.join(' AND ');
    const countRow = await queryOne(`
        SELECT COUNT(*) AS total
        FROM knowledge_docs d
        LEFT JOIN knowledge_collections c ON c.id = d.collection_id AND c.deleted_at IS NULL
        WHERE ${whereSql}
    `, params);
    const total = Number(countRow?.total || 0);
    const tagAgg = groupConcat('t.tag', ',');
    const docs = (await query(`
        SELECT
            d.*,
            c.name AS collection_name,
            c.scope AS collection_scope,
            c.allowed_units AS collection_allowed_units,
            c.allowed_user_ids AS collection_allowed_user_ids,
            COALESCE((
                SELECT ${tagAgg}
                FROM knowledge_doc_tags t
                WHERE t.doc_id = d.id AND t.user_id = d.user_id
            ), '') AS tags
        FROM knowledge_docs d
        LEFT JOIN knowledge_collections c ON c.id = d.collection_id AND c.deleted_at IS NULL
        WHERE ${whereSql}
        ORDER BY d.created_at DESC
        LIMIT ? OFFSET ?
    `, [...params, limit, offset])).map(doc => ({
        ...doc,
        can_edit: Number(doc.user_id) === Number(req.user.id),
        read_only: Number(doc.user_id) !== Number(req.user.id),
        shared_readable: canReadKnowledgeResource({
            user_id: doc.user_id,
            scope: doc.collection_scope,
            allowed_units: doc.collection_allowed_units,
            allowed_user_ids: doc.collection_allowed_user_ids
        }, req.user)
    }));
    res.json({ data: docs, total, page, limit });
}));

ragRouter.get('/collections', authMiddleware, asyncHandler(async (req, res) => {
    res.json({ data: await listKnowledgeCollections(req.user) });
}));

ragRouter.get('/tags', authMiddleware, asyncHandler(async (req, res) => {
    res.json({ data: await listKnowledgeTags(req.user, { collectionId: req.query.collectionId }) });
}));

ragRouter.get('/collections/share-options', authMiddleware, asyncHandler(async (req, res) => {
    const options = await getKnowledgeCollectionShareOptions({ collectionId: req.query.collectionId, user: req.user });
    if (!options) return res.status(404).json({ error: '集合不存在或无权管理共享设置' });
    return res.json({ data: options });
}));

ragRouter.patch('/collections/:id/sharing', authMiddleware, asyncHandler(async (req, res) => {
    try {
        const collection = await updateKnowledgeCollectionSharing({ collectionId: req.params.id, user: req.user, body: req.body || {} });
        if (!collection) return res.status(404).json({ error: '集合不存在或无权管理共享设置' });
        auditRagAction(req, '知识库集合共享设置更新', {
            collectionId: collection.id,
            scope: collection.scope,
            allowedUnits: collection.allowed_units,
            allowedUserIds: collection.allowed_user_ids
        });
        return res.json({ success: true, collection });
    } catch (error) {
        return res.status(error.status || 400).json({ error: error.message });
    }
}));

ragRouter.post('/collections', authMiddleware, asyncHandler(async (req, res) => {
    const collection = await createKnowledgeCollection({
        userId: req.user.id,
        name: req.body?.name,
        description: req.body?.description
    });
    if (!collection) return res.status(400).json({ error: '集合名称不能为空' });
    auditRagAction(req, '知识库集合创建', { collectionId: collection.id, name: collection.name });
    return res.json({ success: true, collection });
}));

ragRouter.post('/tags', authMiddleware, asyncHandler(async (req, res) => {
    const tag = await createKnowledgeTag({
        userId: req.user.id,
        tag: req.body?.tag || req.body?.name
    });
    if (!tag) return res.status(400).json({ error: '标签名称不能为空' });
    auditRagAction(req, '知识库标签创建', { tag: tag.tag });
    return res.json({ success: true, tag });
}));

ragRouter.get('/admin/docs/audit', authMiddleware, asyncHandler(async (req, res) => {
    if (!isSuperAdmin(req.user)) {
        return res.status(403).json({ error: '仅 admin 权限层级可查看知识库删除审计' });
    }
    return res.json(await getKnowledgeDocumentAuditList({
        limit: req.query.limit,
        offset: req.query.offset,
        includeActive: req.query.includeActive === 'true'
    }));
}));

ragRouter.get('/summary', authMiddleware, asyncHandler(async (req, res) => {
    const summary = await getKnowledgeDocumentSummaryForUser(req.user, {
        collectionId: req.query.collectionId,
        tag: req.query.tag || req.query.tagName,
        tagNames: req.query.tagNames
    });
    summary.feedback = await getRagFeedbackSummary(req.user.id);
    res.json(summary);
}));

ragRouter.get('/quality-report', authMiddleware, asyncHandler(async (req, res) => {
    res.json(await getKnowledgeQualityReport(req.user));
}));

ragRouter.get('/graph/summary', authMiddleware, asyncHandler(async (req, res) => {
    res.json(await getGraphSummaryAsync(req.user));
}));

ragRouter.get('/graph/entities', authMiddleware, asyncHandler(async (req, res) => {
    res.json(await listEntities({
        userId: req.user.id,
        user: req.user,
        query: req.query.query,
        type: req.query.type,
        quality: req.query.quality,
        limit: req.query.limit,
        offset: req.query.offset
    }));
}));

ragRouter.get('/graph/relations', authMiddleware, asyncHandler(async (req, res) => {
    res.json(await listRelations({
        userId: req.user.id,
        user: req.user,
        entityId: req.query.entityId,
        relationType: req.query.relationType,
        status: req.query.status,
        minConfidence: req.query.minConfidence,
        docId: req.query.docId,
        limit: req.query.limit,
        offset: req.query.offset
    }));
}));

ragRouter.get('/graph/query', authMiddleware, asyncHandler(async (req, res) => {
    res.json(await queryKnowledgeGraph({
        userId: req.user.id,
        user: req.user,
        query: req.query.query,
        entityLimit: req.query.entityLimit,
        relationLimit: req.query.relationLimit
    }));
}));

ragRouter.get('/graph/entities/:id', authMiddleware, asyncHandler(async (req, res) => {
    const graph = await getEntityGraph({
        userId: req.user.id,
        user: req.user,
        entityId: req.params.id,
        depth: req.query.depth,
        status: req.query.status,
        relationType: req.query.relationType,
        limit: req.query.limit
    });
    if (!graph) return res.status(404).json({ error: '实体不存在' });
    return res.json(graph);
}));

ragRouter.put('/graph/entities/:id', authMiddleware, asyncHandler(async (req, res) => {
    const entity = await updateEntity({ userId: req.user.id, entityId: req.params.id, patch: req.body || {} });
    if (!entity) return res.status(404).json({ error: '实体不存在' });
    auditRagAction(req, '知识图谱实体更新', { entityId: req.params.id, name: entity.name });
    return res.json({ success: true, entity });
}));

ragRouter.post('/graph/entities/merge', authMiddleware, asyncHandler(async (req, res) => {
    const graph = await mergeEntities({
        userId: req.user.id,
        sourceEntityId: req.body?.sourceEntityId,
        targetEntityId: req.body?.targetEntityId
    });
    if (!graph) return res.status(400).json({ error: '实体合并参数无效' });
    clearRagCacheForUser(req.user.id);
    auditRagAction(req, '知识图谱实体合并', {
        sourceEntityId: req.body?.sourceEntityId,
        targetEntityId: req.body?.targetEntityId
    });
    return res.json({ success: true, graph });
}));

ragRouter.put('/graph/relations/:id', authMiddleware, asyncHandler(async (req, res) => {
    const relation = await updateRelation({ userId: req.user.id, relationId: req.params.id, patch: req.body || {} });
    if (!relation) return res.status(404).json({ error: '关系不存在' });
    clearRagCacheForUser(req.user.id);
    auditRagAction(req, '知识图谱关系更新', { relationId: req.params.id });
    return res.json({ success: true, relation });
}));

ragRouter.post('/graph/relations/:id/confirm', authMiddleware, asyncHandler(async (req, res) => {
    const relation = await confirmRelation({ userId: req.user.id, relationId: req.params.id });
    if (!relation) return res.status(404).json({ error: '关系不存在或不是待确认状态' });
    clearRagCacheForUser(req.user.id);
    auditRagAction(req, '知识图谱关系确认', { relationId: req.params.id });
    return res.json({ success: true, relation });
}));

ragRouter.delete('/graph/relations/:id', authMiddleware, asyncHandler(async (req, res) => {
    const deleted = await deleteRelation({ userId: req.user.id, relationId: req.params.id });
    if (!deleted) return res.status(404).json({ error: '关系不存在' });
    clearRagCacheForUser(req.user.id);
    auditRagAction(req, '知识图谱关系删除', { relationId: req.params.id });
    return res.json({ success: true });
}));

ragRouter.post('/graph/docs/:id/rebuild', authMiddleware, asyncHandler(async (req, res) => {
    const result = await rebuildGraphForDocument({ userId: req.user.id, docId: req.params.id });
    if (!result) return res.status(404).json({ error: '文档不存在' });
    clearRagCacheForUser(req.user.id);
    auditRagAction(req, '知识图谱文档重建', result);
    return res.json({ success: true, ...result });
}));

ragRouter.get('/docs/:id', authMiddleware, asyncHandler(async (req, res) => {
    const detail = await getKnowledgeDocumentDetail({
        docId: req.params.id,
        userId: req.user.id,
        user: req.user,
        limit: req.query.limit,
        offset: req.query.offset
    });
    if (!detail) return res.status(404).json({ error: '文档不存在' });
    return res.json(detail);
}));

ragRouter.put('/docs/:id/enabled', authMiddleware, asyncHandler(async (req, res) => {
    const enabled = req.body?.enabled !== false;
    const changed = await setKnowledgeDocumentEnabled({ docId: req.params.id, userId: req.user.id, enabled });
    if (!changed) return res.status(404).json({ error: '文档不存在' });
    auditRagAction(req, '知识库文档启停', { docId: req.params.id, enabled });
    req.log?.info({ docId: req.params.id, enabled }, 'RAG 文档启停状态已更新');
    return res.json({ success: true });
}));

ragRouter.put('/docs/:id/collection', authMiddleware, asyncHandler(async (req, res) => {
    const doc = await setKnowledgeDocumentCollection({
        docId: req.params.id,
        userId: req.user.id,
        collectionId: req.body?.collectionId,
        collectionName: req.body?.collectionName
    });
    if (!doc) return res.status(404).json({ error: '文档不存在或集合无效' });
    auditRagAction(req, '知识库文档集合更新', { docId: req.params.id, collectionId: doc.collection_id || null });
    return res.json({ success: true, doc });
}));

ragRouter.put('/docs/:id/tags', authMiddleware, asyncHandler(async (req, res) => {
    const tags = await setKnowledgeDocumentTags({
        docId: req.params.id,
        userId: req.user.id,
        tags: req.body?.tags
    });
    if (!tags) return res.status(404).json({ error: '文档不存在' });
    auditRagAction(req, '知识库文档标签更新', { docId: req.params.id, tags });
    return res.json({ success: true, tags });
}));

ragRouter.delete('/docs/:id', authMiddleware, asyncHandler(async (req, res) => {
    const deleted = await deleteKnowledgeDocument({ docId: req.params.id, userId: req.user.id });
    if (!deleted) return res.status(404).json({ error: 'Knowledge document not found or not owned' });
    auditRagAction(req, '知识库文档删除', { docId: req.params.id, deleted });
    req.log?.info({ docId: req.params.id, deleted }, 'RAG 文档删除');
    res.json({ success: true });
}));

ragRouter.post('/docs/batch-delete', authMiddleware, asyncHandler(async (req, res) => {
    const result = await batchDeleteKnowledgeDocuments({ userId: req.user.id, docIds: req.body?.docIds });
    auditRagAction(req, '知识库文档批量删除', result);
    req.log?.info(result, 'RAG 文档批量删除');
    return res.json({ success: true, ...result });
}));

ragRouter.post('/docs/batch-reindex', authMiddleware, asyncHandler(async (req, res) => {
    const result = await batchReindexKnowledgeDocuments({ userId: req.user.id, docIds: req.body?.docIds, user: req.user });
    auditRagAction(req, '知识库文档批量重建索引', result);
    req.log?.info(result, 'RAG 文档批量重建索引');
    return res.json({ success: true, ...result });
}));

ragRouter.post('/upload', authMiddleware, upload.single('file'), uploadSecurityMiddleware, asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });

    req.file.originalname = normalizeUploadedOriginalName(req.file.originalname);

    const { docId, collectionId } = await createKnowledgeDocumentFromUpload({
        userId: req.user.id,
        file: req.file,
        collectionId: req.body?.collectionId,
        collectionName: req.body?.collectionName,
        tags: req.body?.tags
    });
    scheduleKnowledgeDocumentIndexing({ docId, userId: req.user.id, user: req.user });
    auditRagAction(req, '知识库文档上传', { docId, collectionId, name: req.file.originalname });
    req.log?.info({ docId, collectionId, name: req.file.originalname }, 'RAG 文档上传');
    res.json({ success: true, docId, message: '后台处理中' });
}));

ragRouter.post('/docs/:id/reindex', authMiddleware, asyncHandler(async (req, res) => {
    const doc = await getKnowledgeDocumentForUser(req.params.id, req.user.id);
    if (!doc) return res.status(404).json({ error: '文档不存在' });
    if (!doc.source_path) {
        return res.status(409).json({ error: '原始文件不存在，无法重新索引，请重新上传文档' });
    }

    const result = scheduleKnowledgeDocumentIndexing({ docId: doc.id, userId: req.user.id, user: req.user });
    if (!result.started && result.reason === 'already_processing') {
        return res.status(409).json({ error: '文档正在处理中，请稍后再试' });
    }
    clearRagCacheForUser(req.user.id);
    auditRagAction(req, '知识库文档重新索引', { docId: doc.id });
    req.log?.info({ docId: doc.id }, 'RAG 文档重新索引');
    return res.json({ success: true, docId: doc.id, message: '已加入重新索引队列' });
}));

ragRouter.post('/docs/retry-failed', authMiddleware, asyncHandler(async (req, res) => {
    const result = scheduleFailedKnowledgeDocumentsForUser({ userId: req.user.id, limit: 50, user: req.user });
    clearRagCacheForUser(req.user.id);
    auditRagAction(req, '知识库失败文档重试', result);
    req.log?.info(result, 'RAG 失败文档批量重试');
    return res.json({ success: true, ...result });
}));

ragRouter.get('/debug-query/history', authMiddleware, asyncHandler(async (req, res) => {
    res.json({ data: await listRagDebugQueries(req.user.id, { limit: req.query.limit }) });
}));

ragRouter.post('/debug-query', authMiddleware, debugQueryLimiter, asyncHandler(async (req, res) => {
    const query = String(req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: '请输入检索问题' });

    const startedAt = Date.now();
    const scope = req.body?.ragScope || req.body?.scope || { collectionId: req.body?.collectionId };
    const topK = req.body?.topK;
    const candidateLimit = req.body?.candidateLimit;
    const scoreThreshold = req.body?.scoreThreshold;
    const result = await debugRetrieveContext(req.user.id, query, {
        topK,
        candidateLimit,
        scoreThreshold,
        scope,
        user: req.user
    });
    const queue = getKnowledgeIndexQueueStatus(req.user.id);
    const elapsedMs = Date.now() - startedAt;
    recordRagDebugQuery({
        userId: req.user.id,
        query,
        scope,
        topK,
        candidateLimit,
        scoreThreshold,
        result,
        queue,
        elapsedMs
    });
    recordSlowRagRetrieval({
        query,
        durationMs: elapsedMs,
        debug: true,
        candidateCount: result.candidateCount || 0,
        matchedCount: Array.isArray(result.matches) ? result.matches.filter(item => item.matched).length : 0,
        queue
    });
    if (Number(queue.pending || 0) > 0 && Number(queue.running || 0) >= Math.max(1, Number(queue.maxConcurrent || 1))) {
        recordObservabilityEvent({
            type: 'rag',
            source: 'rag.debug-query',
            severity: 'warning',
            durationMs: elapsedMs,
            message: 'RAG index queue backlog during debug query',
            details: { query: query.slice(0, 500), queue }
        });
    }
    return res.json({ ...result, queue, elapsedMs });
}));
ragRouter.post('/settings/test-embedding', authMiddleware, asyncHandler(async (req, res) => {
    const savedConfig = getEmbeddingConfig(req.user.id).http;
    const config = {
        mode: req.body?.mode || 'http',
        apiUrl: req.body?.apiUrl || savedConfig.url,
        model: req.body?.model || savedConfig.model,
        apiKey: (req.body?.apiKey && req.body.apiKey.trim()) ? req.body.apiKey.trim() : savedConfig.apiKey
    };
    
    const result = await testEmbeddingConnection(config, req.user);
    auditRagAction(req, '向量模型连接测试', {
        mode: config.mode, 
        apiUrl: config.apiUrl,
        success: result.success 
    });
    return res.json(result);
}));

ragRouter.post('/feedback', authMiddleware, asyncHandler(async (req, res) => {
    const result = await recordRagFeedback({
        userId: req.user.id,
        query: req.body?.query,
        chunkId: req.body?.chunkId,
        docName: req.body?.docName,
        score: req.body?.score,
        helpful: req.body?.helpful === true,
        note: req.body?.note
    });
    if (!result) return res.status(400).json({ error: '反馈内容无效' });
    auditRagAction(req, '知识库召回反馈', { id: result.id, helpful: req.body?.helpful === true, chunkId: req.body?.chunkId });
    return res.json({ success: true, ...result });
}));

module.exports = {
    ragRouter,
    retrieveContext,
    cosineSimilarity,
    chunkText,
    clearRagCacheForUser
};
