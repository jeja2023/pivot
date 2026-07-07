const express = require('express');
const { asyncHandler } = require('../../http');
const { isSuperAdmin } = require('../../permissions');
const {
    cancelJob,
    createJobExport,
    createJobFromUpload,
    deleteJob,
    getDocumentProcessingSettings,
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

function requireOcrAdmin(req, res) {
    if (isSuperAdmin(req.user)) return true;
    res.status(403).json({ error: '\u4ec5 admin \u8d26\u53f7\u53ef\u67e5\u770b\u548c\u914d\u7f6e OCR \u5f15\u64ce\u3002' });
    return false;
}
function readOcrConfig(body = {}, user = null) {
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

function createOcrRouter({ authMiddleware, uploadLimiter, upload, logAction }) {
    const router = express.Router();

    router.get('/settings', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireOcrAdmin(req, res)) return;
        return res.json({ settings: getDocumentProcessingSettings() });
    }));

    router.put('/settings', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireOcrAdmin(req, res)) return;
        try {
            const settings = updateDocumentProcessingSettings({
                patch: { serviceUrl: req.body?.serviceUrl },
                userId: req.user.id
            });
            logAction?.(req, 'OCR 服务地址更新', `服务地址: ${settings.serviceUrl}`);
            return res.json({ success: true, settings });
        } catch (error) {
            return res.status(error.status || 400).json({ error: error.message || 'OCR 服务地址保存失败' });
        }
    }));
    router.get('/engines', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireOcrAdmin(req, res)) return;
        res.json({ engines: await getOcrEngineStatus() });
    }));

    router.get('/jobs', authMiddleware, asyncHandler(async (req, res) => {
        res.json(listJobs({
            userId: req.user.id,
            page: req.query.page,
            limit: req.query.limit,
            status: req.query.status,
            jobType: 'ocr',
            sourceModule: 'ocr_app'
        }));
    }));

    router.post('/jobs', authMiddleware, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
        if (!req.file) return res.status(400).json({ error: '请上传图片或 PDF 文件' });
        const detail = await createJobFromUpload({
            user: req.user,
            file: req.file,
            jobType: 'ocr',
            sourceModule: 'ocr_app',
            sourceRef: req.body?.sourceRef,
            config: readOcrConfig(req.body || {}, req.user)
        });
        logAction?.(req, '文字识别任务创建', `任务: ${detail.job.id}，文件: ${detail.file.originalName}`);
        return res.json({ success: true, ...detail });
    }));

    router.get('/jobs/:id', authMiddleware, asyncHandler(async (req, res) => {
        const detail = getJobDetail({ userId: req.user.id, jobId: req.params.id });
        if (!detail || detail.job.sourceModule !== 'ocr_app') return res.status(404).json({ error: '文字识别任务不存在' });
        return res.json(detail);
    }));

    router.post('/jobs/:id/retry', authMiddleware, asyncHandler(async (req, res) => {
        const detail = retryJob({ userId: req.user.id, jobId: req.params.id });
        if (!detail || detail.job.sourceModule !== 'ocr_app') return res.status(404).json({ error: '文字识别任务不存在' });
        return res.json({ success: true, ...detail });
    }));

    router.post('/jobs/:id/cancel', authMiddleware, asyncHandler(async (req, res) => {
        const detail = cancelJob({ userId: req.user.id, jobId: req.params.id });
        if (!detail || detail.job.sourceModule !== 'ocr_app') return res.status(404).json({ error: '文字识别任务不存在' });
        return res.json({ success: true, ...detail });
    }));

    router.delete('/jobs/:id', authMiddleware, asyncHandler(async (req, res) => {
        const job = deleteJob({ userId: req.user.id, jobId: req.params.id, sourceModule: 'ocr_app' });
        if (!job) return res.status(404).json({ error: '文字识别任务不存在' });
        logAction?.(req, '文字识别任务删除', `任务: ${job.id}`);
        return res.json({ success: true, job });
    }));

    router.post('/jobs/:id/outputs', authMiddleware, asyncHandler(async (req, res) => {
        const output = await createJobExport({ userId: req.user.id, jobId: req.params.id, format: req.body?.format });
        if (!output) return res.status(404).json({ error: '文字识别结果不存在或暂无可导出内容' });
        return res.json({ success: true, output });
    }));

    router.post('/jobs/:id/share', authMiddleware, asyncHandler(async (req, res) => {
        const share = await shareJobResult({
            user: req.user,
            jobId: req.params.id,
            target: req.body?.target,
            options: req.body || {}
        });
        if (!share) return res.status(404).json({ error: '\u6587\u5b57\u8bc6\u522b\u4efb\u52a1\u4e0d\u5b58\u5728' });
        logAction?.(req, 'OCR \u7ed3\u679c\u5206\u53d1', '\u4efb\u52a1: ' + req.params.id + '\uff0c\u76ee\u6807: ' + share.target);
        return res.json({ success: true, share });
    }));

    router.get('/outputs/:id/download', authMiddleware, asyncHandler(async (req, res) => {
        const output = getOutputDownload({ userId: req.user.id, outputId: req.params.id });
        if (!output) return res.status(404).json({ error: '识别结果文件不存在或已过期' });
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
        if (!detail || detail.job.sourceModule !== 'ocr_app') return res.status(404).json({ error: '文字识别页面不存在' });
        return res.json({ success: true, ...detail });
    }));

    return router;
}

module.exports = {
    createOcrRouter
};
