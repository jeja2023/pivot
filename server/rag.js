/* Knowledge base and RAG API facade */
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { db } = require('./db');
const { authMiddleware } = require('./auth');
const { asyncHandler, getClientIp } = require('./http');
const { getBeijingTimestamp } = require('./time');
const { normalizeUploadedOriginalName } = require('./upload');
const { clearRagCacheForUser } = require('./services/rag-cache');
const {
    batchDeleteKnowledgeDocuments,
    batchReindexKnowledgeDocuments,
    createKnowledgeDocumentFromUpload,
    deleteKnowledgeDocument,
    getKnowledgeDocumentAuditList,
    getKnowledgeDocumentDetail,
    getKnowledgeDocumentForUser,
    getKnowledgeQualityReport,
    getKnowledgeDocumentSummaryForUser,
    getRagFeedbackSummary,
    recordRagFeedback,
    scheduleFailedKnowledgeDocumentsForUser,
    scheduleKnowledgeDocumentIndexing,
    setKnowledgeDocumentEnabled
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
    deleteRelation,
    getEntityGraph,
    getGraphSummary,
    listEntities,
    listRelations,
    mergeEntities,
    rebuildGraphForDocument,
    updateEntity,
    updateRelation
} = require('./services/knowledge-graph');
const { normalizeAuditAction } = require('./audit-actions');

const ragRouter = express.Router();
const debugQueryLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '召回测试请求过于频繁，请稍后再试' }
});
const upload = multer({
    dest: 'uploads/docs/',
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        file.originalname = normalizeUploadedOriginalName(file.originalname);
        if (/\.(txt|md|pdf|doc|docx|xls|xlsx|csv|json|html|htm)$/i.test(file.originalname || '')) return cb(null, true);
        cb(new Error('仅支持 txt、md、pdf、doc、docx、xls、xlsx、csv、json、html 文档'));
    }
});

function auditRagAction(req, action, details) {
    try {
        db.prepare('INSERT INTO audit_logs (user_id, action, details, ip_address, timestamp) VALUES (?, ?, ?, ?, ?)')
            .run(req.user?.id || null, normalizeAuditAction(action), JSON.stringify(details || {}), getClientIp(req), getBeijingTimestamp());
    } catch (e) {
        req.log?.warn({ err: e.message, action }, 'RAG 审计日志写入失败');
    }
}

const isSuperAdmin = (user) => user?.username === 'admin';

ragRouter.get('/docs', authMiddleware, (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 100);
    const offset = (page - 1) * limit;
    const total = db.prepare('SELECT COUNT(*) AS total FROM knowledge_docs WHERE user_id = ? AND deleted_at IS NULL').get(req.user.id)?.total || 0;
    const docs = db.prepare('SELECT * FROM knowledge_docs WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?').all(req.user.id, limit, offset);
    res.json({ data: docs, total, page, limit });
});

ragRouter.get('/admin/docs/audit', authMiddleware, (req, res) => {
    if (!isSuperAdmin(req.user)) {
        return res.status(403).json({ error: '仅 admin 超级管理员可查看知识库删除审计' });
    }
    return res.json(getKnowledgeDocumentAuditList({
        limit: req.query.limit,
        offset: req.query.offset,
        includeActive: req.query.includeActive === 'true'
    }));
});

ragRouter.get('/summary', authMiddleware, (req, res) => {
    const summary = getKnowledgeDocumentSummaryForUser(req.user.id);
    summary.feedback = getRagFeedbackSummary(req.user.id);
    res.json(summary);
});

ragRouter.get('/quality-report', authMiddleware, (req, res) => {
    res.json(getKnowledgeQualityReport(req.user.id));
});

ragRouter.get('/graph/summary', authMiddleware, (req, res) => {
    res.json(getGraphSummary(req.user.id));
});

ragRouter.get('/graph/entities', authMiddleware, (req, res) => {
    res.json(listEntities({
        userId: req.user.id,
        query: req.query.query,
        type: req.query.type,
        limit: req.query.limit,
        offset: req.query.offset
    }));
});

ragRouter.get('/graph/relations', authMiddleware, (req, res) => {
    res.json(listRelations({
        userId: req.user.id,
        entityId: req.query.entityId,
        relationType: req.query.relationType,
        limit: req.query.limit,
        offset: req.query.offset
    }));
});

ragRouter.get('/graph/entities/:id', authMiddleware, (req, res) => {
    const graph = getEntityGraph({
        userId: req.user.id,
        entityId: req.params.id,
        depth: req.query.depth,
        limit: req.query.limit
    });
    if (!graph) return res.status(404).json({ error: '实体不存在' });
    return res.json(graph);
});

ragRouter.put('/graph/entities/:id', authMiddleware, asyncHandler(async (req, res) => {
    const entity = updateEntity({ userId: req.user.id, entityId: req.params.id, patch: req.body || {} });
    if (!entity) return res.status(404).json({ error: '实体不存在' });
    auditRagAction(req, '知识图谱实体更新', { entityId: req.params.id, name: entity.name });
    return res.json({ success: true, entity });
}));

ragRouter.post('/graph/entities/merge', authMiddleware, asyncHandler(async (req, res) => {
    const graph = mergeEntities({
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
    const relation = updateRelation({ userId: req.user.id, relationId: req.params.id, patch: req.body || {} });
    if (!relation) return res.status(404).json({ error: '关系不存在' });
    clearRagCacheForUser(req.user.id);
    auditRagAction(req, '知识图谱关系更新', { relationId: req.params.id });
    return res.json({ success: true, relation });
}));

ragRouter.delete('/graph/relations/:id', authMiddleware, asyncHandler(async (req, res) => {
    const deleted = deleteRelation({ userId: req.user.id, relationId: req.params.id });
    if (!deleted) return res.status(404).json({ error: '关系不存在' });
    clearRagCacheForUser(req.user.id);
    auditRagAction(req, '知识图谱关系删除', { relationId: req.params.id });
    return res.json({ success: true });
}));

ragRouter.post('/graph/docs/:id/rebuild', authMiddleware, asyncHandler(async (req, res) => {
    const result = rebuildGraphForDocument({ userId: req.user.id, docId: req.params.id });
    if (!result) return res.status(404).json({ error: '文档不存在' });
    clearRagCacheForUser(req.user.id);
    auditRagAction(req, '知识图谱文档重建', result);
    return res.json({ success: true, ...result });
}));

ragRouter.get('/docs/:id', authMiddleware, (req, res) => {
    const detail = getKnowledgeDocumentDetail({
        docId: req.params.id,
        userId: req.user.id,
        limit: req.query.limit,
        offset: req.query.offset
    });
    if (!detail) return res.status(404).json({ error: '文档不存在' });
    return res.json(detail);
});

ragRouter.put('/docs/:id/enabled', authMiddleware, asyncHandler(async (req, res) => {
    const enabled = req.body?.enabled !== false;
    const changed = setKnowledgeDocumentEnabled({ docId: req.params.id, userId: req.user.id, enabled });
    if (!changed) return res.status(404).json({ error: '文档不存在' });
    auditRagAction(req, '知识库文档启停', { docId: req.params.id, enabled });
    req.log?.info({ docId: req.params.id, enabled }, 'RAG 文档启停状态已更新');
    return res.json({ success: true });
}));

ragRouter.delete('/docs/:id', authMiddleware, (req, res) => {
    const deleted = deleteKnowledgeDocument({ docId: req.params.id, userId: req.user.id });
    auditRagAction(req, '知识库文档删除', { docId: req.params.id, deleted });
    req.log?.info({ docId: req.params.id, deleted }, 'RAG 文档删除');
    res.json({ success: true });
});

ragRouter.post('/docs/batch-delete', authMiddleware, asyncHandler(async (req, res) => {
    const result = batchDeleteKnowledgeDocuments({ userId: req.user.id, docIds: req.body?.docIds });
    auditRagAction(req, '知识库文档批量删除', result);
    req.log?.info(result, 'RAG 文档批量删除');
    return res.json({ success: true, ...result });
}));

ragRouter.post('/docs/batch-reindex', authMiddleware, asyncHandler(async (req, res) => {
    const result = batchReindexKnowledgeDocuments({ userId: req.user.id, docIds: req.body?.docIds });
    auditRagAction(req, '知识库文档批量重建索引', result);
    req.log?.info(result, 'RAG 文档批量重建索引');
    return res.json({ success: true, ...result });
}));

ragRouter.post('/upload', authMiddleware, upload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });

    req.file.originalname = normalizeUploadedOriginalName(req.file.originalname);

    const { docId } = createKnowledgeDocumentFromUpload({ userId: req.user.id, file: req.file });
    scheduleKnowledgeDocumentIndexing({ docId, userId: req.user.id });
    auditRagAction(req, '知识库文档上传', { docId, name: req.file.originalname });
    req.log?.info({ docId, name: req.file.originalname }, 'RAG 文档上传');
    res.json({ success: true, docId, message: '后台处理中' });
}));

ragRouter.post('/docs/:id/reindex', authMiddleware, asyncHandler(async (req, res) => {
    const doc = getKnowledgeDocumentForUser(req.params.id, req.user.id);
    if (!doc) return res.status(404).json({ error: '文档不存在' });
    if (!doc.source_path) {
        return res.status(409).json({ error: '原始文件不存在，无法重新索引，请重新上传文档' });
    }

    const result = scheduleKnowledgeDocumentIndexing({ docId: doc.id, userId: req.user.id });
    if (!result.started && result.reason === 'already_processing') {
        return res.status(409).json({ error: '文档正在处理中，请稍后再试' });
    }
    clearRagCacheForUser(req.user.id);
    auditRagAction(req, '知识库文档重新索引', { docId: doc.id });
    req.log?.info({ docId: doc.id }, 'RAG 文档重新索引');
    return res.json({ success: true, docId: doc.id, message: '已加入重新索引队列' });
}));

ragRouter.post('/docs/retry-failed', authMiddleware, asyncHandler(async (req, res) => {
    const result = scheduleFailedKnowledgeDocumentsForUser({ userId: req.user.id, limit: 50 });
    clearRagCacheForUser(req.user.id);
    auditRagAction(req, '知识库失败文档重试', result);
    req.log?.info(result, 'RAG 失败文档批量重试');
    return res.json({ success: true, ...result });
}));

ragRouter.post('/debug-query', authMiddleware, debugQueryLimiter, asyncHandler(async (req, res) => {
    const query = String(req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: '请输入检索问题' });

    const startedAt = Date.now();
    const result = await debugRetrieveContext(req.user.id, query, {
        topK: req.body?.topK,
        candidateLimit: req.body?.candidateLimit,
        scoreThreshold: req.body?.scoreThreshold
    });
    // 把检索耗时回填，给前端"检索可视化"展示用
    return res.json({ ...result, elapsedMs: Date.now() - startedAt });
}));

ragRouter.post('/settings/test-embedding', authMiddleware, asyncHandler(async (req, res) => {
    const savedConfig = getEmbeddingConfig(req.user.id).http;
    const config = {
        mode: req.body?.mode || 'http',
        apiUrl: req.body?.apiUrl || savedConfig.url,
        model: req.body?.model || savedConfig.model,
        apiKey: (req.body?.apiKey && req.body.apiKey.trim()) ? req.body.apiKey.trim() : savedConfig.apiKey
    };
    
    const result = await testEmbeddingConnection(config);
    auditRagAction(req, '向量模型连接测试', {
        mode: config.mode, 
        apiUrl: config.apiUrl,
        success: result.success 
    });
    return res.json(result);
}));

ragRouter.post('/feedback', authMiddleware, asyncHandler(async (req, res) => {
    const result = recordRagFeedback({
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
