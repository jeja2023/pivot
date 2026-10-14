'use strict';

function createOcrJobProcessor(deps) {
    const {
        createTextOutputs, getBlocks, getJobRow, getPages, getPdfPageMetrics,
        imageFileToPage, insertOcrBlocks, insertPage, isCancelled, isImageExtension, isPdfExtension,
        JOB_STATUSES, JOB_TYPES, parsePageSelection, pagesToText, recognizePage, renderPdfPagesToFiles,
        resolveStoredDocumentPath, sanitizeErrorMessage, touchProgress,
        updateDocumentFileMetadata, updateJobCoverage, updatePageText
    } = deps;

    function analyzeOcrIssues(result, threshold) {
        const issues = [];
        const blocks = Array.isArray(result?.blocks) ? result.blocks : [];
        if (!String(result?.text || '').trim()) issues.push({ type: 'empty_text', severity: 'warning', message: '未识别到可用文字。' });
        blocks.forEach((block, index) => {
            if (block.confidence === null || block.confidence === undefined) issues.push({ type: 'unknown_confidence', severity: 'warning', blockIndex: index, message: '文字块未提供置信度。' });
            else if (Number(block.confidence) < threshold) issues.push({ type: 'low_confidence', severity: 'warning', blockIndex: index, message: '文字块置信度低于复核阈值。' });
        });
        (String(result?.text || '').match(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g) || []).forEach(value => {
            const [, month, day] = value.split(/[-/.]/).map(Number);
            if (month < 1 || month > 12 || day < 1 || day > 31) issues.push({ type: 'date_suspect', severity: 'warning', value, message: '发现格式异常的日期候选。' });
        });
        return issues.slice(0, 500);
    }

    async function preparePagesForJob({ job, file, filePath, config }) {
        const userId = job.user_id;
        if (isImageExtension(file.file_ext)) {
            const existing = await getPages(job.id);
            if (existing.length) return existing;
            const page = await imageFileToPage({ filePath, relativePath: file.file_path, pageNumber: 1 });
            const row = await insertPage({ userId, fileId: file.id, jobId: job.id, ...page, pixelWidth: page.width, pixelHeight: page.height, pdfWidth: Number(page.width || 0) * 72 / Math.max(Number(config.dpi || 220), 72), pdfHeight: Number(page.height || 0) * 72 / Math.max(Number(config.dpi || 220), 72), ocrStatus: job.job_type === JOB_TYPES.OCR ? 'processing' : 'pending' });
            await updateDocumentFileMetadata({ fileId: file.id, userId, pageCount: 1, metadata: { image: { width: page.width, height: page.height } } });
            await updateJobCoverage(job.id, { sourcePageCount: 1, plannedPages: [1] });
            return [row];
        }
        if (!isPdfExtension(file.file_ext)) return [];
        const metrics = await getPdfPageMetrics(file, { password: config.password, userId });
        const selectedPageNumbers = parsePageSelection(config.pages || config.pageRanges, metrics.length, { defaultAll: true, limit: Math.min(config.maxRenderPages, config.maxOcrPages) }).map(index => index + 1);
        const existingPages = await getPages(job.id);
        const existingByNumber = new Map(existingPages.map(page => [Number(page.page_number), page]));
        const missingPageNumbers = selectedPageNumbers.filter(pageNumber => !existingByNumber.has(pageNumber));
        const rendered = missingPageNumbers.length ? await renderPdfPagesToFiles({ filePath, userId, jobId: job.id, options: { password: config.password, pageNumbers: missingPageNumbers, maxPages: missingPageNumbers.length, desiredWidth: Math.round(config.dpi * 6.4) } }) : [];
        const rows = selectedPageNumbers.filter(pageNumber => existingByNumber.has(pageNumber)).map(pageNumber => existingByNumber.get(pageNumber));
        for (const page of rendered) {
            const metric = metrics.find(item => item.pageNumber === page.pageNumber) || {};
            rows.push(await insertPage({ userId, fileId: file.id, jobId: job.id, pageNumber: page.pageNumber, width: page.width, height: page.height, pixelWidth: page.pixelWidth || page.width, pixelHeight: page.pixelHeight || page.height, pdfWidth: metric.pdfWidth || 0, pdfHeight: metric.pdfHeight || 0, rotation: metric.rotation || 0, cropBox: metric.cropBox || {}, imagePath: page.imagePath, ocrStatus: job.job_type === JOB_TYPES.OCR ? 'processing' : 'pending' }));
        }
        if (rows.length !== selectedPageNumbers.length) throw new Error(`PDF 预览仅生成 ${rows.length}/${selectedPageNumbers.length} 页，未发布不完整的识别结果。`);
        await updateDocumentFileMetadata({ fileId: file.id, userId, pageCount: metrics.length, metadata: { pdf: { totalPages: metrics.length, renderedPages: rows.length } } });
        await updateJobCoverage(job.id, { sourcePageCount: metrics.length, plannedPages: selectedPageNumbers });
        return rows;
    }

    async function recognizePages({ job, file, pages, config }) {
        const recognizedPages = [];
        const allBlocks = [];
        const failedPages = [];
        let needsReview = false;
        for (let index = 0; index < pages.length; index += 1) {
            if (await isCancelled(job.id)) throw new Error('任务已取消');
            const page = pages[index];
            try {
                const imagePath = resolveStoredDocumentPath(page.image_path);
                if (!imagePath) throw new Error(`第 ${page.page_number} 页预览图不存在，无法进行 OCR。`);
                const result = await recognizePage(imagePath, { language: config.language, engine: config.engine, dpi: config.dpi, timeoutMs: config.timeoutMs, confidenceThreshold: config.confidenceThreshold });
                const issues = analyzeOcrIssues(result, config.confidenceThreshold);
                const pageNeedsReview = issues.length > 0 || result.confidence === null || result.confidence < config.confidenceThreshold;
                needsReview = needsReview || pageNeedsReview;
                const updatedPage = await updatePageText({ pageId: page.id, text: result.text, rawText: result.text, ocrStatus: pageNeedsReview ? JOB_STATUSES.NEEDS_REVIEW : JOB_STATUSES.SUCCEEDED, processingState: JOB_STATUSES.SUCCEEDED, confidence: result.confidence, result: { engine: result.engine, language: result.language, confidenceSource: result.confidence === null ? 'unknown' : 'engine', blockCount: result.blocks.length, tables: result.tables || [], quality: result.quality, model: result.model, issues }, contentRevision: 1, alignmentStatus: 'aligned' });
                await insertOcrBlocks({ userId: job.user_id, fileId: file.id, jobId: job.id, pageId: page.id, pageNumber: page.page_number, blocks: result.blocks });
                recognizedPages.push(updatedPage);
                allBlocks.push(...result.blocks);
            } catch (error) {
                failedPages.push(Number(page.page_number));
                await updatePageText({ pageId: page.id, text: '', rawText: '', ocrStatus: JOB_STATUSES.FAILED, processingState: JOB_STATUSES.FAILED, confidence: null, result: { errorCode: error.code || 'OCR_PAGE_FAILED', errorMessage: sanitizeErrorMessage(error) }, contentRevision: 1, alignmentStatus: 'unaligned' });
            }
            await touchProgress(job.id, 35 + Math.floor(((index + 1) / Math.max(pages.length, 1)) * 50), { processedPages: recognizedPages.length, failedPages: failedPages.length }, Number(job.execution_epoch));
        }
        const freshJob = await getJobRow(job.id);
        const coverage = await updateJobCoverage(job.id, { sourcePageCount: Number(freshJob?.source_page_count || pages.length), plannedPages: pages.map(page => Number(page.page_number)), processedPages: recognizedPages.map(page => Number(page.page_number)), failedPages });
        return { pages: recognizedPages, blocks: allBlocks, needsReview, failedPages, coverage, truncated: false };
    }

    async function processImageOcr({ job, file, filePath, config }) {
        const pages = await preparePagesForJob({ job, file, filePath, config });
        const recognized = await recognizePages({ job, file, pages, config });
        const finalPages = await getPages(job.id);
        const blocks = await getBlocks(job.id);
        const outputs = await createTextOutputs({ userId: job.user_id, file, job, pages: finalPages, blocks });
        return { status: recognized.failedPages.length ? JOB_STATUSES.PARTIAL_SUCCESS : (recognized.needsReview ? JOB_STATUSES.NEEDS_REVIEW : JOB_STATUSES.SUCCEEDED), progress: 100, result: { textLength: pagesToText(finalPages).length, outputs, lowConfidence: recognized.needsReview, failedPages: recognized.failedPages, coverage: recognized.coverage, truncated: false } };
    }

    return { preparePagesForJob, recognizePages, processImageOcr };
}

module.exports = { createOcrJobProcessor };
