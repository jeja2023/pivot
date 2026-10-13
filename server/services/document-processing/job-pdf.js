'use strict';

function createPdfJobProcessor(deps) {
    const {
        assertPdfInputFiles,
        createSearchablePdfOutput,
        getBlocks,
        getDocumentFileForUser,
        getDocumentFilePathAsync,
        getPages,
        isCancelled,
        JOB_STATUSES,
        PDF_TOOL_OPERATIONS,
        preparePagesForJob,
        processPdfToolOperation,
        recognizePages,
        recordJobItem,
        requirePdfOperation,
        resetJobItems,
        sanitizeErrorMessage,
        touchProgress
    } = deps;

    return async function processPdfToolJob({ job, file, config }) {
        const sourceIds = (Array.isArray(config.sourceFileIds) && config.sourceFileIds.length ? config.sourceFileIds : [file.id])
            .map(id => Number.parseInt(id, 10))
            .filter(id => Number.isSafeInteger(id) && id > 0)
            .slice(0, 50);
        const files = [];
        for (const id of sourceIds) {
            const source = await getDocumentFileForUser(id, job.user_id);
            if (source) files.push(source);
        }
        if (!files.length) throw new Error('PDF 工具任务的源文件不存在，请重新上传。');
        const operation = requirePdfOperation(config.operation);
        const input = assertPdfInputFiles({ operation, files, mode: config.mode });
        if (operation === PDF_TOOL_OPERATIONS.SEARCHABLE_PDF) {
            const targetFile = input.files[0];
            const targetPath = await getDocumentFilePathAsync(targetFile);
            if (!targetPath) throw new Error('PDF 工具任务的源文件不存在，请重新上传。');
            const pageLimit = Math.min(Math.max(Number.parseInt(config.maxToolPages, 10) || 20, 1), 300);
            const searchableConfig = { ...config, maxRenderPages: pageLimit, maxOcrPages: pageLimit };
            const pages = await preparePagesForJob({ job, file: targetFile, filePath: targetPath, config: searchableConfig });
            const recognized = await recognizePages({ job, file: targetFile, pages, config: searchableConfig });
            const finalPages = await getPages(job.id);
            const blocks = await getBlocks(job.id);
            const output = await createSearchablePdfOutput({ userId: job.user_id, file: targetFile, job, pages: finalPages, blocks });
            return {
                status: recognized.needsReview ? JOB_STATUSES.NEEDS_REVIEW : JOB_STATUSES.SUCCEEDED,
                progress: 100,
                result: { operation, outputs: [output], processedFiles: 1, processedPages: finalPages.length, lowConfidence: recognized.needsReview, truncated: recognized.truncated }
            };
        }
        const runOne = async (source, index = 0, total = 1) => await processPdfToolOperation({
            job,
            file: source,
            files: [source],
            config: { ...config, mode: 'single' },
            isCancelled: () => isCancelled(job.id),
            onProgress: async (progress, patch = {}) => {
                const adjusted = total > 1 ? Math.floor((index / total) * 80 + (progress / 100) * (80 / total) + 10) : progress;
                await touchProgress(job.id, adjusted, patch);
            }
        });
        let result;
        if (config.mode === 'batch' && input.meta.inputMode === 'single-or-batch' && input.files.length > 1) {
            const aggregate = { outputs: [], processedFiles: 0, processedPages: 0, requestedPages: 0, items: [], failedFiles: 0 };
            await resetJobItems(job.id);
            for (let index = 0; index < input.files.length; index += 1) {
                const source = input.files[index];
                try {
                    const item = await runOne(source, index, input.files.length);
                    aggregate.outputs.push(...(item.outputs || []));
                    aggregate.processedFiles += 1;
                    aggregate.processedPages += Number(item.processedPages || 0);
                    aggregate.requestedPages += Number(item.requestedPages || 0);
                    aggregate.items.push({ fileId: source.id, originalName: source.original_name, status: 'succeeded', outputs: item.outputs || [] });
                    await recordJobItem({ job, file: source, itemOrder: index, status: JOB_STATUSES.SUCCEEDED, result: { outputIds: (item.outputs || []).map(output => output.id).filter(Boolean), processedPages: Number(item.processedPages || 0), requestedPages: Number(item.requestedPages || 0) } });
                } catch (error) {
                    if (await isCancelled(job.id)) throw error;
                    aggregate.failedFiles += 1;
                    aggregate.items.push({ fileId: source.id, originalName: source.original_name, status: 'failed', errorCode: error.code || 'PROCESSING_FAILED', errorMessage: sanitizeErrorMessage(error) });
                    await recordJobItem({ job, file: source, itemOrder: index, status: JOB_STATUSES.FAILED, progress: 0, errorCode: error.code || 'PROCESSING_FAILED', errorMessage: sanitizeErrorMessage(error) });
                }
            }
            if (!aggregate.processedFiles) {
                const firstFailure = aggregate.items.find(item => item.status === 'failed');
                const error = new Error(firstFailure?.errorMessage || '批量 PDF 处理失败。');
                error.code = firstFailure?.errorCode || 'PROCESSING_FAILED';
                throw error;
            }
            result = aggregate;
        } else if ([PDF_TOOL_OPERATIONS.MERGE, PDF_TOOL_OPERATIONS.IMAGES_TO_PDF, PDF_TOOL_OPERATIONS.COMPARE].includes(operation)) {
            result = await processPdfToolOperation({ job, file: input.files[0], files: input.files, config, isCancelled: () => isCancelled(job.id), onProgress: (progress, patch = {}) => touchProgress(job.id, progress, patch) });
        } else {
            result = await runOne(input.files[0]);
        }
        return {
            status: result.failedFiles ? JOB_STATUSES.PARTIAL_SUCCESS : JOB_STATUSES.SUCCEEDED,
            progress: 100,
            result: {
                operation: result.operation,
                outputs: result.outputs || [],
                processedFiles: result.processedFiles || 0,
                processedPages: result.processedPages || 0,
                requestedPages: result.requestedPages || 0,
                removedPages: result.removedPages || 0,
                textLength: result.textLength || 0,
                failedFiles: result.failedFiles || 0,
                items: result.items || []
            }
        };
    };
}

module.exports = { createPdfJobProcessor };
