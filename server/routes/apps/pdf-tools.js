const express = require('express');
const { asyncHandler } = require('../../http');
const {
    cancelJob,
    createPdfToolJobFromUploads,
    deleteJob,
    getJobDetail,
    getJobOutputsArchive,
    getOutputDownload,
    listJobs,
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
        password: body.password
    };
}

function createPdfToolsRouter({ authMiddleware, uploadLimiter, upload, logAction }) {
    const router = express.Router();

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
        const detail = await getJobDetail({ userId: req.user.id, jobId: req.params.id });
        if (!detail || detail.job.sourceModule !== 'pdf_tools') return res.status(404).json({ error: 'PDF 工具任务不存在' });
        return res.json(detail);
    }));

    router.post('/jobs/:id/retry', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await retryJob({ userId: req.user.id, jobId: req.params.id });
        if (!detail || detail.job.sourceModule !== 'pdf_tools') return res.status(404).json({ error: 'PDF 工具任务不存在' });
        return res.json({ success: true, ...detail });
    }));

    router.post('/jobs/:id/cancel', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await cancelJob({ userId: req.user.id, jobId: req.params.id });
        if (!detail || detail.job.sourceModule !== 'pdf_tools') return res.status(404).json({ error: 'PDF 工具任务不存在' });
        return res.json({ success: true, ...detail });
    }));

    router.delete('/jobs/:id', authMiddleware, asyncHandler(async (req, res) => {
        const job = await deleteJob({ userId: req.user.id, jobId: req.params.id, sourceModule: 'pdf_tools' });
        if (!job) return res.status(404).json({ error: 'PDF 工具任务不存在' });
        logAction?.(req, 'PDF 工具任务删除', `任务: ${job.id}`);
        return res.json({ success: true, job });
    }));

    router.get('/jobs/:id/outputs/download', authMiddleware, asyncHandler(async (req, res) => {
        const archive = await getJobOutputsArchive({ userId: req.user.id, jobId: req.params.id, sourceModule: 'pdf_tools' });
        if (!archive) return res.status(404).json({ error: 'PDF 工具输出不存在或已过期' });
        res.setHeader('Content-Type', archive.mimeType);
        res.setHeader('Content-Length', archive.buffer.length);
        res.attachment(archive.fileName);
        return res.send(archive.buffer);
    }));

    router.get('/outputs/:id/download', authMiddleware, asyncHandler(async (req, res) => {
        const output = await getOutputDownload({ userId: req.user.id, outputId: req.params.id });
        if (!output) return res.status(404).json({ error: '输出文件不存在或已过期' });
        res.setHeader('Content-Type', output.mimeType);
        return res.download(output.filePath, output.fileName);
    }));

    return router;
}

module.exports = {
    createPdfToolsRouter
};
