const express = require('express');
const { asyncHandler } = require('../../http');
const {
    cancelJob,
    createPdfToolJobFromUploads,
    deleteJob,
    dispatchPdfJobResult,
    getPdfToolCapabilities,
    getJobDetail,
    getJobOutputsArchiveStream,
    getOutputDownload,
    getPageImage,
    listJobs,
    reprocessJob,
    retryJob
} = require('../../services/document-processing');

function readPdfToolConfig(body = {}) {
    return {
        operation: body.operation || body.pdfOperation,
        pages: body.pages || body.pageRanges,
        pageRanges: body.pageRanges || body.pages,
        pageOrder: body.pageOrder,
        rotateDegrees: body.rotateDegrees,
        maxToolPages: body.maxToolPages,
        maxRenderPages: body.maxRenderPages,
        dpi: body.dpi,
        password: body.password,
        mode: body.mode,
        watermarkText: body.watermarkText,
        watermarkPosition: body.watermarkPosition,
        watermarkFontSize: body.watermarkFontSize,
        watermarkOpacity: body.watermarkOpacity,
        watermarkRotate: body.watermarkRotate,
        watermarkMargin: body.watermarkMargin,
        pageNumberPosition: body.pageNumberPosition,
        pageNumberStart: body.pageNumberStart,
        pageNumberPrefix: body.pageNumberPrefix,
        pageNumberSuffix: body.pageNumberSuffix,
        pageNumberFontSize: body.pageNumberFontSize,
        pageNumberMargin: body.pageNumberMargin,
        skipCover: body.skipCover,
        cropLeft: body.cropLeft,
        cropRight: body.cropRight,
        cropTop: body.cropTop,
        cropBottom: body.cropBottom,
        blankPageAfter: body.blankPageAfter,
        blankPageCount: body.blankPageCount,
        pageSize: body.pageSize,
        imageFit: body.imageFit,
        imageDpi: body.imageDpi,
        pageMargin: body.pageMargin,
        compressionMode: body.compressionMode,
        compressionJpegQuality: body.compressionJpegQuality,
        outputPassword: body.outputPassword,
        ownerPassword: body.ownerPassword,
        outputPermissions: body.outputPermissions,
        redactRegions: body.redactRegions,
        annotations: body.annotations,
        formValues: body.formValues,
        pdfaProfile: body.pdfaProfile,
        compareDpi: body.compareDpi,
        replaceText: body.replaceText,
        pagePlan: body.pagePlan
    };
}

function definedPdfToolConfig(config = {}) {
    return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
}

function createPdfToolsRouter({ authMiddleware, uploadLimiter, upload, logAction }) {
    const router = express.Router();

    router.get('/capabilities', authMiddleware, asyncHandler(async (_req, res) => {
        return res.json(await getPdfToolCapabilities());
    }));

    router.get('/jobs', authMiddleware, asyncHandler(async (req, res) => {
        res.json(await listJobs({
            userId: req.user.id,
            page: req.query.page,
            limit: req.query.limit,
            status: req.query.status,
            jobType: 'pdf_tool',
            sourceModule: 'pdf_tools'
        }));
    }));

    router.post('/jobs', authMiddleware, uploadLimiter, upload.array('files', 20), asyncHandler(async (req, res) => {
        const files = Array.isArray(req.files) ? req.files : [];
        if (!files.length) return res.status(400).json({ error: '请上传需要处理的 PDF 或图片文件' });
        const config = readPdfToolConfig(req.body || {});
        const detail = await createPdfToolJobFromUploads({
            user: req.user,
            files,
            operation: config.operation,
            sourceRef: req.body?.sourceRef,
            config
        });
        logAction?.(req, 'PDF 工具任务创建', `任务: ${detail.job.id}，文件数: ${files.length}`);
        return res.json({ success: true, ...detail });
    }));

    router.get('/jobs/:id', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await getJobDetail({ userId: req.user.id, jobId: req.params.id, sourceModule: 'pdf_tools' });
        if (!detail) return res.status(404).json({ error: 'PDF 工具任务不存在' });
        return res.json(detail);
    }));

    router.get('/jobs/:id/preflight', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await getJobDetail({ userId: req.user.id, jobId: req.params.id, sourceModule: 'pdf_tools' });
        if (!detail) return res.status(404).json({ error: 'PDF 工具任务不存在' });
        return res.json({ preflight: detail.preflight });
    }));

    router.post('/jobs/:id/retry', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await retryJob({ userId: req.user.id, jobId: req.params.id, sourceModule: 'pdf_tools', password: req.body?.password, outputPassword: req.body?.outputPassword, ownerPassword: req.body?.ownerPassword });
        if (!detail) return res.status(404).json({ error: 'PDF 工具任务不存在' });
        return res.json({ success: true, ...detail });
    }));

    router.post('/jobs/:id/reprocess', authMiddleware, asyncHandler(async (req, res) => {
        const configPatch = req.body?.config && typeof req.body.config === 'object' && !Array.isArray(req.body.config)
            ? req.body.config
            : definedPdfToolConfig(readPdfToolConfig(req.body || {}));
        const detail = await reprocessJob({ userId: req.user.id, jobId: req.params.id, sourceModule: 'pdf_tools', password: req.body?.password, outputPassword: req.body?.outputPassword, ownerPassword: req.body?.ownerPassword, configPatch });
        if (!detail) return res.status(404).json({ error: 'PDF 工具任务不存在' });
        logAction?.(req, 'PDF 工具再次处理', `来源任务: ${req.params.id}，新任务: ${detail.job.id}`);
        return res.json({ success: true, ...detail });
    }));

    router.post('/jobs/:id/dispatch', authMiddleware, asyncHandler(async (req, res) => {
        const dispatch = await dispatchPdfJobResult({
            user: req.user,
            jobId: req.params.id,
            target: req.body?.target,
            options: req.body || {}
        });
        if (!dispatch) return res.status(404).json({ error: 'PDF 工具任务或输出文件不存在' });
        logAction?.(req, 'PDF 处理结果分发', `任务: ${req.params.id}，输出: ${dispatch.outputId}，目标: ${dispatch.target}`);
        return res.json({ success: true, dispatch });
    }));

    router.post('/jobs/:id/cancel', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await cancelJob({ userId: req.user.id, jobId: req.params.id, sourceModule: 'pdf_tools' });
        if (!detail) return res.status(404).json({ error: 'PDF 工具任务不存在' });
        return res.json({ success: true, ...detail });
    }));

    router.delete('/jobs/:id', authMiddleware, asyncHandler(async (req, res) => {
        const job = await deleteJob({ userId: req.user.id, jobId: req.params.id, sourceModule: 'pdf_tools' });
        if (!job) return res.status(404).json({ error: 'PDF 工具任务不存在' });
        logAction?.(req, 'PDF 工具任务删除', `任务: ${job.id}`);
        return res.json({ success: true, job });
    }));

    router.get('/jobs/:id/outputs/download', authMiddleware, asyncHandler(async (req, res) => {
        const archive = await getJobOutputsArchiveStream({ userId: req.user.id, jobId: req.params.id, sourceModule: 'pdf_tools' });
        if (!archive) return res.status(404).json({ error: 'PDF 工具输出不存在或已过期' });
        res.setHeader('Content-Type', archive.mimeType);
        res.attachment(archive.fileName);
        archive.stream.once('error', error => {
            if (!res.headersSent) res.status(500).json({ error: '归档流生成失败' });
            else res.destroy(error);
        });
        return archive.stream.pipe(res);
    }));

    router.get('/outputs/:id/download', authMiddleware, asyncHandler(async (req, res) => {
        const output = await getOutputDownload({ userId: req.user.id, outputId: req.params.id, sourceModule: 'pdf_tools' });
        if (!output) return res.status(404).json({ error: '输出文件不存在或已过期' });
        res.setHeader('Content-Type', output.mimeType);
        return res.download(output.filePath, output.fileName);
    }));

    router.get('/pages/:id/image', authMiddleware, asyncHandler(async (req, res) => {
        const image = await getPageImage({ userId: req.user.id, pageId: req.params.id, sourceModule: 'pdf_tools' });
        if (!image) return res.status(404).json({ error: 'PDF 页面预览不存在或已过期' });
        return res.sendFile(image.filePath);
    }));

    return router;
}

module.exports = {
    createPdfToolsRouter
};
