const express = require('express');
const { asyncHandler } = require('../../http');
const { isAdmin, isSuperAdmin } = require('../../permissions');
const {
    cancelJob,
    createJobExport,
    createJobFromUpload,
    getDocumentProcessingSettings,
    getDocumentProcessingStats,
    getJobDetail,
    getOcrEngineStatus,
    getOutputDownload,
    getPageImage,
    listJobs,
    retryJob,
    savePageReview,
    shareJobResult,
    updateDocumentProcessingSettings
} = require('../../services/document-processing');

function requireDocumentProcessingAdmin(req, res) {
    if (isAdmin(req.user)) return true;
    res.status(403).json({ error: '\u9700\u8981\u7ba1\u7406\u5458\u6743\u9650\u3002' });
    return false;
}

function requireDocumentProcessingSuperAdmin(req, res) {
    if (isSuperAdmin(req.user)) return true;
    res.status(403).json({ error: '\u4ec5 admin \u8d26\u53f7\u53ef\u67e5\u770b\u548c\u914d\u7f6e OCR \u5f15\u64ce\u3002' });
    return false;
}

function readJobConfig(body = {}, user = null) {
    return {
        language: body.language,
        engine: isSuperAdmin(user) ? body.engine : undefined,
        dpi: body.dpi,
        maxRenderPages: body.maxRenderPages,
        maxOcrPages: body.maxOcrPages,
        confidenceThreshold: body.confidenceThreshold,
        timeoutMs: body.timeoutMs,
        password: body.password
    };
}

function createDocumentProcessingRouter({ authMiddleware, uploadLimiter, upload, logAction }) {
    const router = express.Router();

    router.get('/admin/settings', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireDocumentProcessingSuperAdmin(req, res)) return;
        return res.json({ settings: getDocumentProcessingSettings() });
    }));

    router.put('/admin/settings', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireDocumentProcessingSuperAdmin(req, res)) return;
        const settings = updateDocumentProcessingSettings({ patch: req.body || {}, userId: req.user.id });
        logAction?.(req, '\u6587\u6863\u5904\u7406\u914d\u7f6e\u66f4\u65b0', '\u66f4\u65b0 OCR/PDF \u5904\u7406\u9650\u5236');
        return res.json({ success: true, settings });
    }));

    router.get('/admin/stats', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireDocumentProcessingAdmin(req, res)) return;
        return res.json(getDocumentProcessingStats());
    }));

    router.get('/engines', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireDocumentProcessingSuperAdmin(req, res)) return;
        res.json({ engines: await getOcrEngineStatus() });
    }));

    router.get('/jobs', authMiddleware, asyncHandler(async (req, res) => {
        res.json(listJobs({
            userId: req.user.id,
            page: req.query.page,
            limit: req.query.limit,
            status: req.query.status,
            jobType: req.query.jobType,
            sourceModule: req.query.sourceModule
        }));
    }));

    router.post('/jobs', authMiddleware, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
        if (!req.file) return res.status(400).json({ error: '请上传文件' });
        const detail = await createJobFromUpload({
            user: req.user,
            file: req.file,
            jobType: req.body?.jobType,
            sourceModule: req.body?.sourceModule || 'document_processing',
            sourceRef: req.body?.sourceRef,
            config: readJobConfig(req.body || {}, req.user)
        });
        logAction?.(req, '文档处理任务创建', `任务: ${detail.job.id}，文件: ${detail.file.originalName}`);
        return res.json({ success: true, ...detail });
    }));

    router.get('/jobs/:id', authMiddleware, asyncHandler(async (req, res) => {
        const detail = getJobDetail({ userId: req.user.id, jobId: req.params.id });
        if (!detail) return res.status(404).json({ error: '任务不存在' });
        return res.json(detail);
    }));

    router.post('/jobs/:id/retry', authMiddleware, asyncHandler(async (req, res) => {
        const detail = retryJob({ userId: req.user.id, jobId: req.params.id });
        if (!detail) return res.status(404).json({ error: '任务不存在' });
        logAction?.(req, '文档处理任务重试', `任务: ${req.params.id}`);
        return res.json({ success: true, ...detail });
    }));

    router.post('/jobs/:id/cancel', authMiddleware, asyncHandler(async (req, res) => {
        const detail = cancelJob({ userId: req.user.id, jobId: req.params.id });
        if (!detail) return res.status(404).json({ error: '任务不存在' });
        logAction?.(req, '文档处理任务取消', `任务: ${req.params.id}`);
        return res.json({ success: true, ...detail });
    }));

    router.post('/jobs/:id/outputs', authMiddleware, asyncHandler(async (req, res) => {
        const output = await createJobExport({
            userId: req.user.id,
            jobId: req.params.id,
            format: req.body?.format || req.body?.outputType
        });
        if (!output) return res.status(404).json({ error: '任务不存在或暂无可导出内容' });
        logAction?.(req, '文档处理结果导出', `任务: ${req.params.id}，格式: ${output.outputType}`);
        return res.json({ success: true, output });
    }));

    router.post('/jobs/:id/share', authMiddleware, asyncHandler(async (req, res) => {
        const share = await shareJobResult({
            user: req.user,
            jobId: req.params.id,
            target: req.body?.target,
            options: req.body || {}
        });
        if (!share) return res.status(404).json({ error: '\u6587\u6863\u5904\u7406\u4efb\u52a1\u4e0d\u5b58\u5728' });
        logAction?.(req, 'OCR \u7ed3\u679c\u5206\u53d1', '\u4efb\u52a1: ' + req.params.id + '\uff0c\u76ee\u6807: ' + share.target);
        return res.json({ success: true, share });
    }));

    router.get('/outputs/:id/download', authMiddleware, asyncHandler(async (req, res) => {
        const output = getOutputDownload({ userId: req.user.id, outputId: req.params.id });
        if (!output) return res.status(404).json({ error: '输出文件不存在或已过期' });
        res.setHeader('Content-Type', output.mimeType);
        return res.download(output.filePath, output.fileName);
    }));

    router.get('/pages/:id/image', authMiddleware, asyncHandler(async (req, res) => {
        const image = getPageImage({ userId: req.user.id, pageId: req.params.id });
        if (!image) return res.status(404).json({ error: '页面预览不存在' });
        return res.sendFile(image.filePath);
    }));

    router.put('/pages/:id/review', authMiddleware, asyncHandler(async (req, res) => {
        const detail = savePageReview({
            userId: req.user.id,
            pageId: req.params.id,
            revisedText: req.body?.revisedText ?? req.body?.text,
            reviewStatus: req.body?.reviewStatus || 'reviewed',
            lowConfidenceConfirmed: req.body?.lowConfidenceConfirmed === true
        });
        if (!detail) return res.status(404).json({ error: '页面不存在' });
        logAction?.(req, '文档处理人工复核', `页面: ${req.params.id}`);
        return res.json({ success: true, ...detail });
    }));

    return router;
}

module.exports = {
    createDocumentProcessingRouter
};
