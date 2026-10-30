const express = require('express');
const { asyncHandler } = require('../../http');
const { isSuperAdmin } = require('../../permissions');
const { removeUploadedFile } = require('../../upload');
const {
    cancelJob,
    getExportRequest,
    createJobFromUpload,
    createOcrBatchFromUploads,
    createOcrRegionCandidate,
    submitOcrFeedback,
    listOcrFeedback,
    reviewOcrFeedback,
    assignReviewers,
    completeReview,
    deleteJob,
    getDocumentProcessingSettings,
    extractOcrFields,
    getOcrCapabilities,
    getJobDetail,
    getJobPageSlice,
    getPageRevisions,
    getOcrChatContext,
    getOcrEngineStatus,
    getOutputDownload,
    preflightOcrUploads,
    requestJobExport,
    getPageImage,
    listJobs,
    listOcrRegionCandidates,
    listReviewAssignments,
    listReviewCandidates,
    retryJob,
    savePageReview,
    shareJobResult,
    updateDocumentProcessingSettings
} = require('../../services/document-processing');

function requireOcrAdmin(req, res) {
    if (isSuperAdmin(req.user)) return true;
    res.status(403).json({ error: '仅 admin 账号可查看和配置 OCR 引擎。' });
    return false;
}

function readOcrConfig(body = {}, user = null) {
    return {
        language: body.language,
        engine: isSuperAdmin(user) ? body.engine : undefined,
        dpi: body.dpi,
        maxRenderPages: body.maxRenderPages,
        maxOcrPages: body.maxOcrPages,
        pages: body.pages || body.pageRanges,
        confidenceThreshold: body.confidenceThreshold,
        timeoutMs: body.timeoutMs,
        password: body.password
    };
}

function createOcrRouter({ authMiddleware, uploadLimiter, upload, logAction }) {
    const router = express.Router();
    const receiveOcrFiles = typeof upload.array === 'function' ? upload.array('files', 20) : upload.single('file');

    router.get('/settings', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireOcrAdmin(req, res)) return;
        return res.json({ settings: getDocumentProcessingSettings() });
    }));

    router.put('/settings', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireOcrAdmin(req, res)) return;
        try {
            const settings = await updateDocumentProcessingSettings({
                patch: { serviceUrl: req.body?.serviceUrl },
                userId: req.user.id
            });
            logAction?.(req, 'OCR 服务地址更新', `服务地址: ${settings.serviceUrl}`);
            return res.json({ success: true, settings });
        } catch (error) {
            if (error.status === 400) return res.status(400).json({ error: error.message || 'OCR 服务地址保存失败' });
            throw error;
        }
    }));

    router.get('/engines', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireOcrAdmin(req, res)) return;
        res.json({ engines: await getOcrEngineStatus() });
    }));

    router.get('/capabilities', authMiddleware, asyncHandler(async (req, res) => {
        const capabilities = await getOcrCapabilities({ includeServiceUrl: isSuperAdmin(req.user) });
        const settings = getDocumentProcessingSettings();
        return res.json({
            capabilities: {
                ...capabilities,
                limits: {
                    maxRenderPages: settings.maxRenderPages,
                    maxOcrPages: settings.maxOcrPages,
                    maxConcurrentJobs: settings.maxConcurrentJobs
                }
            }
        });
    }));

    router.post('/preflight', authMiddleware, uploadLimiter, receiveOcrFiles, asyncHandler(async (req, res) => {
        const files = Array.isArray(req.files) && req.files.length ? req.files : (req.file ? [req.file] : []);
        try {
            const preflight = await preflightOcrUploads({ files, config: readOcrConfig(req.body || {}, req.user) });
            return res.json({ preflight });
        } finally {
            await Promise.all(files.map(file => removeUploadedFile(file)));
        }
    }));

    router.get('/jobs', authMiddleware, asyncHandler(async (req, res) => {
        res.json(await listJobs({
            userId: req.user.id,
            page: req.query.page,
            limit: req.query.limit,
            status: req.query.status,
            jobType: 'ocr',
            sourceModule: 'ocr_app'
        }));
    }));

    router.post('/jobs', authMiddleware, uploadLimiter, receiveOcrFiles, asyncHandler(async (req, res) => {
        const files = Array.isArray(req.files) && req.files.length ? req.files : (req.file ? [req.file] : []);
        if (!files.length) return res.status(400).json({ error: '请上传图片或 PDF 文件' });
        const config = readOcrConfig(req.body || {}, req.user);
        if (files.length > 1) {
            const batch = await createOcrBatchFromUploads({
                user: req.user,
                files,
                sourceRef: req.body?.sourceRef,
                config
            });
            logAction?.(req, '文字识别批量任务创建', `批次: ${batch.batch.id}，文件数: ${files.length}`);
            return res.json({ success: true, ...batch });
        }
        const detail = await createJobFromUpload({
            user: req.user,
            file: files[0],
            jobType: 'ocr',
            sourceModule: 'ocr_app',
            sourceRef: req.body?.sourceRef,
            config
        });
        logAction?.(req, '文字识别任务创建', `任务: ${detail.job.id}，文件: ${detail.file.originalName}`);
        return res.json({ success: true, ...detail });
    }));

    router.get('/jobs/:id', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await getJobDetail({ userId: req.user.id, jobId: req.params.id, sourceModule: 'ocr_app' });
        if (!detail) return res.status(404).json({ error: '文字识别任务不存在' });
        return res.json(detail);
    }));

    router.get('/jobs/:id/fields', authMiddleware, asyncHandler(async (req, res) => {
        const fields = await extractOcrFields({ userId: req.user.id, jobId: req.params.id });
        if (!fields) return res.status(404).json({ error: '文字识别任务不存在' });
        return res.json({ fields });
    }));

    router.get('/jobs/:id/pages', authMiddleware, asyncHandler(async (req, res) => {
        const result = await getJobPageSlice({
            userId: req.user.id,
            jobId: req.params.id,
            sourceModule: 'ocr_app',
            page: req.query.page,
            limit: req.query.limit
        });
        if (!result) return res.status(404).json({ error: '文字识别任务不存在' });
        return res.json(result);
    }));

    router.get('/jobs/:id/context', authMiddleware, asyncHandler(async (req, res) => {
        const context = await getOcrChatContext({ userId: req.user.id, jobId: req.params.id });
        if (!context) return res.status(404).json({ error: '文字识别任务不存在' });
        return res.json({ context });
    }));

    router.get('/jobs/:id/reviewers', authMiddleware, asyncHandler(async (req, res) => {
        const assignments = await listReviewAssignments({ userId: req.user.id, jobId: req.params.id });
        if (!assignments) return res.status(404).json({ error: '文字识别任务不存在或无权查看复核安排' });
        return res.json({ assignments });
    }));

    router.get('/jobs/:id/reviewer-candidates', authMiddleware, asyncHandler(async (req, res) => {
        const candidates = await listReviewCandidates({ ownerUserId: req.user.id, jobId: req.params.id });
        if (!candidates) return res.status(404).json({ error: '文字识别任务不存在或无权分派复核人' });
        return res.json({
            candidates,
            ownerUnit: candidates.ownerUnit || '',
            reason: candidates.reason || ''
        });
    }));

    router.put('/jobs/:id/reviewers', authMiddleware, asyncHandler(async (req, res) => {
        const assignments = await assignReviewers({
            ownerUserId: req.user.id,
            jobId: req.params.id,
            reviewerUserIds: req.body?.reviewerUserIds,
            note: req.body?.note
        });
        if (!assignments) return res.status(404).json({ error: '文字识别任务不存在或无权分派复核人' });
        logAction?.(req, '文字识别复核分派', `任务: ${req.params.id}，复核人数: ${assignments.length}`);
        return res.json({ success: true, assignments });
    }));

    router.post('/jobs/:id/review-complete', authMiddleware, asyncHandler(async (req, res) => {
        const result = await completeReview({ userId: req.user.id, jobId: req.params.id });
        logAction?.(req, '完成文字识别复核', `任务: ${req.params.id}，已确认人数: ${result.approvals}`);
        return res.json({ success: true, review: result });
    }));

    router.post('/jobs/:id/retry', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await retryJob({ userId: req.user.id, jobId: req.params.id, sourceModule: 'ocr_app', password: req.body?.password, retryFailedPages: req.body?.retryFailedPages === true });
        if (!detail) return res.status(404).json({ error: '文字识别任务不存在' });
        return res.json({ success: true, ...detail });
    }));

    router.post('/jobs/:id/cancel', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await cancelJob({ userId: req.user.id, jobId: req.params.id, sourceModule: 'ocr_app' });
        if (!detail) return res.status(404).json({ error: '文字识别任务不存在' });
        return res.json({ success: true, ...detail });
    }));

    router.delete('/jobs/:id', authMiddleware, asyncHandler(async (req, res) => {
        const job = await deleteJob({ userId: req.user.id, jobId: req.params.id, sourceModule: 'ocr_app' });
        if (!job) return res.status(404).json({ error: '文字识别任务不存在' });
        logAction?.(req, '文字识别任务删除', `任务: ${job.id}`);
        return res.json({ success: true, job });
    }));

    router.post('/jobs/:id/outputs', authMiddleware, asyncHandler(async (req, res) => {
        const exportRequest = await requestJobExport({ userId: req.user.id, jobId: req.params.id, format: req.body?.format, sourceModule: 'ocr_app' });
        if (!exportRequest) return res.status(404).json({ error: '文字识别结果不存在或暂无可导出内容' });
        return res.status(exportRequest.status === 'ready' ? 200 : 202).json({ success: true, export: exportRequest });
    }));

    router.get('/exports/:id', authMiddleware, asyncHandler(async (req, res) => {
        const exportRequest = await getExportRequest({ userId: req.user.id, exportId: req.params.id, sourceModule: 'ocr_app' });
        if (!exportRequest) return res.status(404).json({ error: '导出请求不存在或无权查看' });
        return res.json({ export: exportRequest });
    }));

    router.post('/jobs/:id/share', authMiddleware, asyncHandler(async (req, res) => {
        const share = await shareJobResult({
            user: req.user,
            jobId: req.params.id,
            target: req.body?.target,
            options: req.body || {},
            sourceModule: 'ocr_app'
        });
        if (!share) return res.status(404).json({ error: '文字识别任务不存在' });
        logAction?.(req, 'OCR 结果分发', `任务: ${req.params.id}，目标: ${share.target}`);
        return res.json({ success: true, share });
    }));

    router.get('/outputs/:id/download', authMiddleware, asyncHandler(async (req, res) => {
        const output = await getOutputDownload({ userId: req.user.id, outputId: req.params.id, sourceModule: 'ocr_app' });
        if (!output) return res.status(404).json({ error: '识别结果文件不存在或已过期' });
        res.setHeader('Content-Type', output.mimeType);
        return res.download(output.filePath, output.fileName);
    }));

    router.get('/pages/:id/image', authMiddleware, asyncHandler(async (req, res) => {
        const image = await getPageImage({ userId: req.user.id, pageId: req.params.id, sourceModule: 'ocr_app' });
        if (!image) return res.status(404).json({ error: '页面预览不存在' });
        return res.sendFile(image.filePath);
    }));

    router.get('/pages/:id/revisions', authMiddleware, asyncHandler(async (req, res) => {
        const history = await getPageRevisions({ userId: req.user.id, pageId: req.params.id, sourceModule: 'ocr_app' });
        if (!history) return res.status(404).json({ error: '文字识别页面不存在或无权查看修订历史' });
        return res.json(history);
    }));

    router.get('/pages/:id/regions', authMiddleware, asyncHandler(async (req, res) => {
        const candidates = await listOcrRegionCandidates({ userId: req.user.id, pageId: req.params.id });
        if (!candidates) return res.status(404).json({ error: '文字识别页面不存在或无权查看区域候选' });
        return res.json({ candidates });
    }));

    router.post('/pages/:id/regions', authMiddleware, asyncHandler(async (req, res) => {
        const candidate = await createOcrRegionCandidate({
            userId: req.user.id,
            pageId: req.params.id,
            region: req.body?.region || req.body,
            options: readOcrConfig(req.body || {}, req.user)
        });
        if (!candidate) return res.status(404).json({ error: '文字识别页面不存在或无权创建区域候选' });
        return res.json({ success: true, candidate });
    }));

    router.post('/pages/:id/feedback', authMiddleware, asyncHandler(async (req, res) => {
        const feedback = await submitOcrFeedback({
            userId: req.user.id,
            pageId: req.params.id,
            correctedText: req.body?.correctedText,
            feedbackType: req.body?.feedbackType,
            consented: req.body?.consented === true
        });
        if (!feedback) return res.status(404).json({ error: '文字识别页面不存在或无权提交反馈' });
        logAction?.(req, '提交文字识别纠错反馈', `页面: ${req.params.id}，反馈: ${feedback.id}`);
        return res.json({ success: true, feedback });
    }));

    router.get('/admin/feedback', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireOcrAdmin(req, res)) return;
        return res.json({ feedback: await listOcrFeedback({ status: req.query.status, limit: req.query.limit }) });
    }));

    router.put('/admin/feedback/:id', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireOcrAdmin(req, res)) return;
        const feedback = await reviewOcrFeedback({ reviewerUserId: req.user.id, feedbackId: req.params.id, status: req.body?.status, reviewNote: req.body?.reviewNote });
        logAction?.(req, '审核文字识别纠错反馈', `反馈: ${req.params.id}，结果: ${feedback.status}`);
        return res.json({ success: true, feedback });
    }));

    router.put('/pages/:id/review', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await savePageReview({
            userId: req.user.id,
            pageId: req.params.id,
            revisedText: req.body?.revisedText ?? req.body?.text,
            reviewStatus: req.body?.reviewStatus || 'reviewed',
            lowConfidenceConfirmed: req.body?.lowConfidenceConfirmed === true,
            expectedRevision: req.body?.expectedRevision,
            sourceModule: 'ocr_app'
        });
        if (!detail) return res.status(404).json({ error: '文字识别页面不存在' });
        return res.json({ success: true, ...detail });
    }));

    return router;
}

module.exports = {
    createOcrRouter
};
