const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const {
    PDFDocument,
    PDFArray,
    PDFName,
    degrees,
    rgb,
    TextRenderingMode,
    setTextRenderingMode
} = require('pdf-lib');

const { extractDocumentText, truncateExtractedText } = require('../../../document-text');
const { createCjkFontkit, getCjkFontBuffer, verifyCjkFont } = require('../../document-rendering/cjk-fonts');
const { getKnowledgeLimits } = require('../../resource-limits');
const { OUTPUT_TYPES, isImageExtension, isPdfExtension } = require('../constants');
const { createTextOutputs, registerOutput, serializeOutput } = require('../exporters');
const { renderPdfPagesToFiles } = require('../renderers');
const { buildManagedPath, outputsRoot, resolveStoredDocumentPath } = require('../paths');
const {
    PDF_OPERATION_META,
    PDF_TOOL_OPERATIONS,
    assertPdfInputFiles,
    assertPdfPageCount,
    getPdfOperationMeta,
    normalizePageLimit,
    normalizePdfMode,
    normalizePdfOperation,
    parsePageOrder,
    parsePageSelection,
    requirePdfOperation
} = require('./validation');
const { decryptPdfToBuffer, getQpdfHealth, isPdfEncrypted, optimizePdf } = require('./engines/qpdf');
const { getVeraPdfHealth } = require('./engines/verapdf');
const { createAdvancedPdfOperations } = require('./operations/advanced');

const MAX_PDF_BUFFER_BYTES = Math.min(Math.max(Number.parseInt(process.env.DOCUMENT_MAX_BUFFER_BYTES || String(256 * 1024 * 1024), 10) || 256 * 1024 * 1024, 8 * 1024 * 1024), 1024 * 1024 * 1024);
const MAX_IMAGE_PIXELS = Math.min(Math.max(Number.parseInt(process.env.DOCUMENT_MAX_IMAGE_PIXELS || String(80 * 1024 * 1024), 10) || 80 * 1024 * 1024, 1_000_000), 250 * 1024 * 1024);
const PAPER_SIZES = Object.freeze({ a4: [595.28, 841.89], a3: [841.89, 1190.55], letter: [612, 792] });

function pdfError(message, code, status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

async function readBoundedBinary(filePath) {
    const size = (await fs.promises.stat(filePath)).size;
    if (size > MAX_PDF_BUFFER_BYTES) {
        throw pdfError(`PDF 或图片大小超过 ${Math.round(MAX_PDF_BUFFER_BYTES / 1024 / 1024)} MB 处理上限。`, 'DOCUMENT_BUFFER_LIMIT_EXCEEDED', 413);
    }
    return fs.promises.readFile(filePath);
}

function baseName(value, fallback = 'PDF结果') {
    return path.basename(String(value || fallback), path.extname(String(value || '')))
        .replace(/[\\/:*?"<>|\0\r\n\t]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || fallback;
}

function sanitizeOutputName(value, fallback = 'pdf-output') {
    return String(value || fallback)
        .replace(/[\\/:*?"<>|\0\r\n\t]/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 120) || fallback;
}

async function getStoredPathForFile(file) {
    const target = resolveStoredDocumentPath(file?.file_path || file?.filePath);
    if (!target || !await fs.promises.access(target, fs.constants.R_OK).then(() => true).catch(() => false)) {
        throw pdfError('原始文件不存在，请重新上传后再处理。', 'SOURCE_FILE_MISSING', 404);
    }
    return target;
}

async function requirePdfFile(file) {
    if (!file || !isPdfExtension(file.file_ext || file.fileExt)) throw pdfError('该操作仅支持 PDF 文件。', 'UNSUPPORTED_FILE_TYPE');
    return getStoredPathForFile(file);
}

async function requireImageFile(file) {
    if (!file || !isImageExtension(file.file_ext || file.fileExt)) throw pdfError('图片转 PDF 仅支持图片文件。', 'UNSUPPORTED_FILE_TYPE');
    return getStoredPathForFile(file);
}

function normalizePdfLoadError(error) {
    if (error?.code) return error;
    const text = String(error?.message || error || '');
    if (/encrypted|password/i.test(text)) {
        const qpdf = getQpdfHealth();
        return qpdf.available
            ? pdfError('该 PDF 已加密，请提供授权密码后重试。', 'PDF_PASSWORD_REQUIRED')
            : pdfError('当前 PDF 结构处理暂不支持加密文件。请先使用授权工具解除保护后再处理。', 'PDF_ENCRYPTION_UNSUPPORTED');
    }
    return error;
}

async function loadPdf(file, { password = '', userId = 0 } = {}) {
    const filePath = await requirePdfFile(file);
    try {
        return await PDFDocument.load(await readBoundedBinary(filePath));
    } catch (error) {
        if (/encrypted|password/i.test(String(error?.message || error || '')) && password) {
            try {
                return await PDFDocument.load(await decryptPdfToBuffer({ sourcePath: filePath, password, userId }));
            } catch (decryptionError) {
                throw normalizePdfLoadError(decryptionError);
            }
        }
        throw normalizePdfLoadError(error);
    }
}

function pdfLoadOptions(job, config = {}) {
    return { password: String(config.password || ''), userId: job?.user_id || 0 };
}

async function ensureNotCancelled(isCancelled) {
    if (typeof isCancelled === 'function' && await isCancelled()) throw pdfError('任务已取消，未发布新的输出文件。', 'JOB_CANCELLED', 409);
}

async function writeBinaryOutput({ userId, fileId, jobId, sourceName, suffix, outputType = 'pdf', bytes, mimeType = 'application/pdf', extension = '.pdf', pageCount = 0, quality = {}, versionKey = '' }) {
    const diskName = `${jobId}-gc1-${sanitizeOutputName(outputType)}-${crypto.randomUUID()}${extension}`;
    const targetPath = await buildManagedPath(outputsRoot, userId, diskName);
    await fs.promises.writeFile(targetPath, Buffer.from(bytes));
    const fileName = `${baseName(sourceName)}-${suffix}${extension}`;
    const output = await registerOutput({ userId, fileId, jobId, outputType, filePath: targetPath, fileName, mimeType, pageCount, quality, versionKey });
    return serializeOutput(output);
}

function getSelectedIndexes(pdf, config, { defaultAll = true } = {}) {
    const pageCount = pdf.getPageCount();
    const indexes = parsePageSelection(config.pages || config.pageRanges, pageCount, { defaultAll, limit: config.maxToolPages });
    return { pageCount, indexes };
}

async function savePdfOutput({ pdf, job, file, suffix, outputType, quality = {} }) {
    // 页面整理不修改表单字段值；避免 pdf-lib 使用不具备中文覆盖的默认字体重建原表单外观。
    const bytes = await pdf.save({ useObjectStreams: true, updateFieldAppearances: false });
    return writeBinaryOutput({
        userId: job.user_id,
        fileId: file.id,
        jobId: job.id,
        sourceName: file.original_name,
        suffix,
        outputType,
        bytes,
        pageCount: pdf.getPageCount(),
        quality
    });
}

async function splitPdf({ job, file, config, onProgress, isCancelled }) {
    const source = await loadPdf(file, pdfLoadOptions(job, config));
    const { indexes } = getSelectedIndexes(source, config);
    const outputs = [];
    for (let i = 0; i < indexes.length; i += 1) {
        await ensureNotCancelled(isCancelled);
        const target = await PDFDocument.create();
        const [page] = await target.copyPages(source, [indexes[i]]);
        target.addPage(page);
        outputs.push(await savePdfOutput({
            pdf: target,
            job,
            file,
            suffix: `第${indexes[i] + 1}页`,
            outputType: 'split_pdf',
            quality: { sourcePages: [indexes[i] + 1], complete: true }
        }));
        await onProgress?.(20 + Math.floor(((i + 1) / indexes.length) * 70), { processedPages: i + 1, requestedPages: indexes.length });
    }
    return { outputs, processedFiles: 1, processedPages: indexes.length, requestedPages: indexes.length };
}

async function mergePdf({ job, file, files, config, onProgress, isCancelled }) {
    const { files: pdfFiles } = assertPdfInputFiles({ operation: PDF_TOOL_OPERATIONS.MERGE, files });
    const target = await PDFDocument.create();
    let copiedPages = 0;
    for (let i = 0; i < pdfFiles.length; i += 1) {
        await ensureNotCancelled(isCancelled);
        const source = await loadPdf(pdfFiles[i], pdfLoadOptions(job, config));
        const count = source.getPageCount();
        assertPdfPageCount(copiedPages + count, config.maxToolPages);
        const copied = await target.copyPages(source, Array.from({ length: count }, (_item, index) => index));
        copied.forEach(page => target.addPage(page));
        copiedPages += copied.length;
        await onProgress?.(15 + Math.floor(((i + 1) / pdfFiles.length) * 70), { processedFiles: i + 1, processedPages: copiedPages, requestedPages: copiedPages });
    }
    if (!copiedPages) throw pdfError('未找到可合并的 PDF 页面。', 'PDF_EMPTY');
    return {
        outputs: [await savePdfOutput({ pdf: target, job, file, suffix: '合并结果', outputType: 'merged_pdf', quality: { complete: true, sourceFiles: pdfFiles.length } })],
        processedFiles: pdfFiles.length,
        processedPages: copiedPages,
        requestedPages: copiedPages
    };
}

async function rotatePdf({ job, file, config, onProgress, isCancelled }) {
    const source = await loadPdf(file, pdfLoadOptions(job, config));
    const { pageCount, indexes } = getSelectedIndexes(source, config);
    const selected = new Set(indexes);
    assertPdfPageCount(pageCount, config.maxToolPages);
    const rotateDegrees = Number.parseInt(config.rotateDegrees, 10);
    const delta = [90, 180, 270, -90].includes(rotateDegrees) ? rotateDegrees : 90;
    const target = await PDFDocument.create();
    const copied = await target.copyPages(source, Array.from({ length: pageCount }, (_item, index) => index));
    for (let index = 0; index < copied.length; index += 1) {
        await ensureNotCancelled(isCancelled);
        if (selected.has(index)) {
            const current = copied[index].getRotation().angle || 0;
            copied[index].setRotation(degrees((current + delta + 360) % 360));
        }
        target.addPage(copied[index]);
    }
    await onProgress?.(90, { processedPages: pageCount, requestedPages: indexes.length });
    return {
        outputs: [await savePdfOutput({ pdf: target, job, file, suffix: '旋转结果', outputType: 'rotated_pdf', quality: { complete: true, changedPages: indexes.map(value => value + 1) } })],
        processedFiles: 1,
        processedPages: pageCount,
        requestedPages: indexes.length
    };
}

async function deletePdfPages({ job, file, config, onProgress, isCancelled }) {
    const source = await loadPdf(file, pdfLoadOptions(job, config));
    const { pageCount, indexes } = getSelectedIndexes(source, config, { defaultAll: false });
    if (!indexes.length) throw pdfError('请填写需要删除的页码范围。', 'INVALID_PAGE_RANGE');
    const selected = new Set(indexes);
    const keep = Array.from({ length: pageCount }, (_item, index) => index).filter(index => !selected.has(index));
    if (!keep.length) throw pdfError('不能删除 PDF 的全部页面。', 'PDF_EMPTY');
    assertPdfPageCount(keep.length, config.maxToolPages);
    await ensureNotCancelled(isCancelled);
    const target = await PDFDocument.create();
    const copied = await target.copyPages(source, keep);
    copied.forEach(page => target.addPage(page));
    await onProgress?.(90, { processedPages: keep.length, requestedPages: keep.length, removedPages: indexes.length });
    return {
        outputs: [await savePdfOutput({ pdf: target, job, file, suffix: '删页结果', outputType: 'deleted_pages_pdf', quality: { complete: true, removedPages: indexes.map(value => value + 1) } })],
        processedFiles: 1,
        processedPages: keep.length,
        requestedPages: keep.length,
        removedPages: indexes.length
    };
}

async function reorderPdf({ job, file, config, onProgress, isCancelled }) {
    const source = await loadPdf(file, pdfLoadOptions(job, config));
    const order = parsePageOrder(config.pageOrder || config.pages, source.getPageCount(), { limit: config.maxToolPages });
    await ensureNotCancelled(isCancelled);
    const target = await PDFDocument.create();
    const copied = await target.copyPages(source, order);
    copied.forEach(page => target.addPage(page));
    await onProgress?.(90, { processedPages: copied.length, requestedPages: copied.length });
    return {
        outputs: [await savePdfOutput({ pdf: target, job, file, suffix: '重排结果', outputType: 'reordered_pdf', quality: { complete: true, order: order.map(value => value + 1) } })],
        processedFiles: 1,
        processedPages: copied.length,
        requestedPages: copied.length
    };
}

async function applyPagePlan({ job, file, config, onProgress, isCancelled }) {
    const source = await loadPdf(file, pdfLoadOptions(job, config));
    const sourceCount = source.getPageCount();
    const plan = Array.isArray(config.pagePlan) ? config.pagePlan : [];
    if (!plan.length) throw pdfError('页面工作区未提交可执行的页面编排。', 'PAGE_PLAN_REQUIRED');
    assertPdfPageCount(plan.length, config.maxToolPages);
    const target = await PDFDocument.create();
    const changes = { copied: 0, rotated: 0, blanks: 0 };
    for (let index = 0; index < plan.length; index += 1) {
        await ensureNotCancelled(isCancelled);
        const item = plan[index];
        if (item.blank) {
            const previous = index > 0 ? plan[index - 1] : null;
            let size = PAPER_SIZES.a4;
            if (previous?.sourcePage > 0 && previous.sourcePage <= sourceCount) {
                const reference = source.getPage(previous.sourcePage - 1);
                size = [reference.getWidth(), reference.getHeight()];
            } else if (item.width > 0 && item.height > 0) {
                size = [item.width, item.height];
            }
            target.addPage(size);
            changes.blanks += 1;
        } else {
            const pageNumber = Number(item.sourcePage || 0);
            if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > sourceCount) {
                throw pdfError(`页面工作区包含无效的源页码 ${pageNumber}。`, 'INVALID_PAGE_PLAN');
            }
            const [copied] = await target.copyPages(source, [pageNumber - 1]);
            const rotation = Number(item.rotation || 0);
            if (rotation) {
                const current = copied.getRotation().angle || 0;
                copied.setRotation(degrees((current + rotation) % 360));
                changes.rotated += 1;
            }
            target.addPage(copied);
            changes.copied += 1;
        }
        await onProgress?.(15 + Math.floor(((index + 1) / plan.length) * 75), { processedPages: index + 1, requestedPages: plan.length });
    }
    return {
        outputs: [await savePdfOutput({ pdf: target, job, file, suffix: '页面编排结果', outputType: 'page_plan_pdf', quality: { complete: true, pagePlan: plan, changes } })],
        processedFiles: 1,
        processedPages: plan.length,
        requestedPages: plan.length
    };
}

async function extractPdfTextOutput({ job, file }) {
    const filePath = await requirePdfFile(file);
    const text = truncateExtractedText(
        await extractDocumentText(filePath, '', file.original_name, { maxChars: getKnowledgeLimits().extractMaxChars }),
        getKnowledgeLimits().extractMaxChars
    );
    if (!String(text || '').trim()) throw pdfError('未提取到可用文本。扫描件请使用“生成可搜索 PDF”或文字识别。', 'TEXT_NOT_FOUND');
    const outputs = await createTextOutputs({
        userId: job.user_id,
        file,
        job,
        text,
        pages: [],
        blocks: [],
        formats: [OUTPUT_TYPES.TEXT, OUTPUT_TYPES.MARKDOWN, OUTPUT_TYPES.JSON]
    });
    return { outputs, processedFiles: 1, processedPages: 0, textLength: String(text).length };
}

async function pdfToImages({ job, file, config, onProgress, isCancelled }) {
    const filePath = await requirePdfFile(file);
    const source = await loadPdf(file, pdfLoadOptions(job, config));
    const { indexes } = getSelectedIndexes(source, config);
    const selected = indexes.map(index => index + 1);
    const dpi = Math.min(Math.max(Number.parseInt(config.dpi, 10) || 220, 72), 600);
    const outputs = [];
    for (let index = 0; index < selected.length; index += 1) {
        await ensureNotCancelled(isCancelled);
        const pageNumber = selected[index];
        const page = source.getPage(pageNumber - 1);
        const desiredWidth = Math.min(Math.round(page.getWidth() * dpi / 72), 10000);
        const rendered = await renderPdfPagesToFiles({
            filePath,
            userId: job.user_id,
            jobId: job.id,
            options: { first: pageNumber, last: pageNumber, maxPages: 1, desiredWidth }
        });
        const outputPage = rendered[0];
        if (!outputPage?.imagePath) throw pdfError(`第 ${pageNumber} 页渲染失败，未发布不完整结果。`, 'OUTPUT_INCOMPLETE');
        const outputPath = resolveStoredDocumentPath(outputPage.imagePath);
        if (!outputPath) throw pdfError(`第 ${pageNumber} 页预览路径无效。`, 'SOURCE_VISUAL_MISSING');
        outputs.push(serializeOutput(await registerOutput({
            userId: job.user_id,
            fileId: file.id,
            jobId: job.id,
            outputType: 'page_image',
            filePath: outputPath,
            fileName: `${baseName(file.original_name)}-第${pageNumber}页.png`,
            mimeType: 'image/png',
            pageCount: 1,
            quality: { dpi, sourcePage: pageNumber, complete: true }
        })));
        await onProgress?.(20 + Math.floor(((index + 1) / selected.length) * 70), { processedPages: index + 1, requestedPages: selected.length, sourcePage: pageNumber });
    }
    if (outputs.length !== selected.length) throw pdfError('输出页数与请求页数不一致，未发布不完整结果。', 'OUTPUT_INCOMPLETE');
    return { outputs, processedFiles: 1, processedPages: outputs.length, requestedPages: selected.length };
}

async function readImageForPdf(file) {
    const filePath = await requireImageFile(file);
    const raw = await readBoundedBinary(filePath);
    const metadata = await sharp(raw).metadata();
    const pixels = Number(metadata.width || 0) * Number(metadata.height || 0);
    if (!pixels || pixels > MAX_IMAGE_PIXELS) throw pdfError('图片分辨率超过安全处理上限，请缩小图片后重试。', 'IMAGE_PIXEL_LIMIT_EXCEEDED', 413);
    const ext = String(file.file_ext || file.fileExt || '').toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') return { bytes: raw, ext, width: metadata.width, height: metadata.height };
    const converted = await sharp(raw).png().toBuffer();
    return { bytes: converted, ext: '.png', width: metadata.width, height: metadata.height };
}

function imagePageBox(image, config = {}) {
    const dpi = Math.min(Math.max(Number.parseInt(config.imageDpi || config.dpi, 10) || 220, 72), 600);
    const paper = PAPER_SIZES[String(config.pageSize || 'original').toLowerCase()];
    const original = [Math.max(1, Number(image.width || 1) * 72 / dpi), Math.max(1, Number(image.height || 1) * 72 / dpi)];
    if (!paper) return { size: original, x: 0, y: 0, width: original[0], height: original[1] };
    const margin = Math.min(Math.max(Number(config.pageMargin || 24), 0), Math.min(paper[0], paper[1]) / 4);
    const available = [paper[0] - margin * 2, paper[1] - margin * 2];
    const cover = String(config.imageFit || 'contain').toLowerCase() === 'cover';
    const scale = cover ? Math.max(available[0] / original[0], available[1] / original[1]) : Math.min(available[0] / original[0], available[1] / original[1]);
    const width = original[0] * scale;
    const height = original[1] * scale;
    return { size: paper, x: (paper[0] - width) / 2, y: (paper[1] - height) / 2, width, height };
}

async function imagesToPdf({ job, file, files, config, onProgress, isCancelled }) {
    const { files: imageFiles } = assertPdfInputFiles({ operation: PDF_TOOL_OPERATIONS.IMAGES_TO_PDF, files });
    assertPdfPageCount(imageFiles.length, config.maxToolPages);
    const pdf = await PDFDocument.create();
    for (let i = 0; i < imageFiles.length; i += 1) {
        await ensureNotCancelled(isCancelled);
        const image = await readImageForPdf(imageFiles[i]);
        const embedded = image.ext === '.jpg' || image.ext === '.jpeg' ? await pdf.embedJpg(image.bytes) : await pdf.embedPng(image.bytes);
        const box = imagePageBox(image, config);
        const page = pdf.addPage(box.size);
        page.drawImage(embedded, { x: box.x, y: box.y, width: box.width, height: box.height });
        await onProgress?.(15 + Math.floor(((i + 1) / imageFiles.length) * 75), { processedFiles: i + 1, processedPages: i + 1, requestedPages: imageFiles.length });
    }
    return {
        outputs: [await savePdfOutput({ pdf, job, file, suffix: '图片转PDF', outputType: 'images_pdf', quality: { complete: true, pageSize: config.pageSize || 'original' } })],
        processedFiles: imageFiles.length,
        processedPages: imageFiles.length,
        requestedPages: imageFiles.length
    };
}

async function getCjkFont(pdf) {
    const check = verifyCjkFont();
    if (!check.available) throw pdfError(`中文 PDF 字体不可用：${check.reason}`, 'PDF_FONT_UNAVAILABLE', 503);
    pdf.registerFontkit(createCjkFontkit());
    return pdf.embedFont(getCjkFontBuffer(), { subset: true });
}

function textPosition(page, text, font, size, position = 'center', margin = 36) {
    const width = page.getWidth();
    const height = page.getHeight();
    const textWidth = font.widthOfTextAtSize(text, size);
    const normalized = String(position || 'center').toLowerCase();
    const map = {
        'top-left': [margin, height - margin - size],
        'top-center': [(width - textWidth) / 2, height - margin - size],
        'top-right': [width - margin - textWidth, height - margin - size],
        center: [(width - textWidth) / 2, (height - size) / 2],
        'bottom-left': [margin, margin],
        'bottom-center': [(width - textWidth) / 2, margin],
        'bottom-right': [width - margin - textWidth, margin]
    };
    return map[normalized] || map.center;
}

async function watermarkPdf({ job, file, config, onProgress, isCancelled }) {
    const pdf = await loadPdf(file, pdfLoadOptions(job, config));
    const { pageCount, indexes } = getSelectedIndexes(pdf, config);
    const font = await getCjkFont(pdf);
    const text = String(config.watermarkText || '机密').trim().slice(0, 120);
    if (!text) throw pdfError('请填写水印文字。', 'WATERMARK_TEXT_REQUIRED');
    const size = Math.min(Math.max(Number(config.watermarkFontSize || 36), 8), 144);
    const opacity = Math.min(Math.max(Number(config.watermarkOpacity ?? 0.18), 0.05), 0.8);
    const angle = Math.min(Math.max(Number(config.watermarkRotate ?? -45), -180), 180);
    const selected = new Set(indexes);
    for (let index = 0; index < pageCount; index += 1) {
        await ensureNotCancelled(isCancelled);
        if (!selected.has(index)) continue;
        const page = pdf.getPage(index);
        const [x, y] = textPosition(page, text, font, size, config.watermarkPosition, Number(config.watermarkMargin || 36));
        page.drawText(text, { x, y, font, size, rotate: degrees(angle), color: rgb(0.32, 0.36, 0.42), opacity });
    }
    await onProgress?.(90, { processedPages: indexes.length, requestedPages: indexes.length });
    return {
        outputs: [await savePdfOutput({ pdf, job, file, suffix: '水印结果', outputType: 'watermarked_pdf', quality: { complete: true, changedPages: indexes.map(value => value + 1) } })],
        processedFiles: 1,
        processedPages: indexes.length,
        requestedPages: indexes.length
    };
}

async function pageNumbersPdf({ job, file, config, onProgress, isCancelled }) {
    const pdf = await loadPdf(file, pdfLoadOptions(job, config));
    const { pageCount, indexes } = getSelectedIndexes(pdf, config);
    const font = await getCjkFont(pdf);
    const selected = new Set(indexes);
    const skipCover = Boolean(config.skipCover);
    const startAt = Math.max(Number.parseInt(config.pageNumberStart, 10) || 1, 1);
    const prefix = String(config.pageNumberPrefix || '').slice(0, 40);
    const suffix = String(config.pageNumberSuffix || '').slice(0, 40);
    const size = Math.min(Math.max(Number(config.pageNumberFontSize || 10), 6), 36);
    let visibleNumber = startAt;
    for (let index = 0; index < pageCount; index += 1) {
        await ensureNotCancelled(isCancelled);
        if (!selected.has(index) || (skipCover && index === 0)) continue;
        const page = pdf.getPage(index);
        const text = `${prefix}${visibleNumber}${suffix}`;
        const [x, y] = textPosition(page, text, font, size, config.pageNumberPosition || 'bottom-center', Number(config.pageNumberMargin || 28));
        page.drawText(text, { x, y, font, size, color: rgb(0.14, 0.18, 0.24) });
        visibleNumber += 1;
    }
    const changed = indexes.filter(index => !(skipCover && index === 0));
    await onProgress?.(90, { processedPages: changed.length, requestedPages: changed.length });
    return {
        outputs: [await savePdfOutput({ pdf, job, file, suffix: '页码结果', outputType: 'page_numbered_pdf', quality: { complete: true, changedPages: changed.map(value => value + 1) } })],
        processedFiles: 1,
        processedPages: changed.length,
        requestedPages: changed.length
    };
}

function cropBoxFromConfig(page, config) {
    const width = page.getWidth();
    const height = page.getHeight();
    const left = Math.min(Math.max(Number(config.cropLeft || 0), 0), width - 1);
    const right = Math.min(Math.max(Number(config.cropRight || 0), 0), width - left - 1);
    const bottom = Math.min(Math.max(Number(config.cropBottom || 0), 0), height - 1);
    const top = Math.min(Math.max(Number(config.cropTop || 0), 0), height - bottom - 1);
    const cropWidth = width - left - right;
    const cropHeight = height - top - bottom;
    if (cropWidth <= 0 || cropHeight <= 0) throw pdfError('裁切边距不能使页面宽度或高度为零。', 'INVALID_CROP');
    return { x: left, y: bottom, width: cropWidth, height: cropHeight };
}

async function cropPdf({ job, file, config, onProgress, isCancelled }) {
    const pdf = await loadPdf(file, pdfLoadOptions(job, config));
    const { pageCount, indexes } = getSelectedIndexes(pdf, config);
    const selected = new Set(indexes);
    for (let index = 0; index < pageCount; index += 1) {
        await ensureNotCancelled(isCancelled);
        if (!selected.has(index)) continue;
        const page = pdf.getPage(index);
        const box = cropBoxFromConfig(page, config);
        page.setCropBox(box.x, box.y, box.width, box.height);
    }
    await onProgress?.(90, { processedPages: indexes.length, requestedPages: indexes.length });
    return {
        outputs: [await savePdfOutput({ pdf, job, file, suffix: '裁切结果', outputType: 'cropped_pdf', quality: { complete: true, changedPages: indexes.map(value => value + 1), note: '裁切仅改变可见区域，不会移除页面隐藏内容。' } })],
        processedFiles: 1,
        processedPages: indexes.length,
        requestedPages: indexes.length
    };
}

async function insertBlankPdf({ job, file, config, onProgress, isCancelled }) {
    const pdf = await loadPdf(file, pdfLoadOptions(job, config));
    const originalCount = pdf.getPageCount();
    assertPdfPageCount(originalCount, config.maxToolPages);
    const count = Math.min(Math.max(Number.parseInt(config.blankPageCount, 10) || 1, 1), 20);
    assertPdfPageCount(originalCount + count, config.maxToolPages);
    const after = Math.min(Math.max(Number.parseInt(config.blankPageAfter, 10) || 0, 0), originalCount);
    const reference = originalCount ? pdf.getPage(Math.min(Math.max(after - 1, 0), originalCount - 1)) : null;
    const size = reference ? [reference.getWidth(), reference.getHeight()] : (PAPER_SIZES[String(config.pageSize || 'a4').toLowerCase()] || PAPER_SIZES.a4);
    for (let offset = 0; offset < count; offset += 1) {
        await ensureNotCancelled(isCancelled);
        pdf.insertPage(after + offset, size);
    }
    await onProgress?.(90, { processedPages: count, requestedPages: count });
    return {
        outputs: [await savePdfOutput({ pdf, job, file, suffix: '插入空白页结果', outputType: 'blank_inserted_pdf', quality: { complete: true, insertedAfterPage: after, insertedCount: count } })],
        processedFiles: 1,
        processedPages: originalCount + count,
        requestedPages: count
    };
}

async function compressPdf({ job, file, config, onProgress, isCancelled }) {
    const sourcePath = await requirePdfFile(file);
    const sourceBytes = await readBoundedBinary(sourcePath);
    const pdf = await loadPdf(file, pdfLoadOptions(job, config));
    assertPdfPageCount(pdf.getPageCount(), config.maxToolPages);
    await ensureNotCancelled(isCancelled);
    const qpdf = getQpdfHealth();
    const bytes = qpdf.available
        ? await optimizePdf({
            sourcePath,
            userId: job.user_id,
            password: config.password,
            optimizeImages: config.compressionMode === 'images',
            jpegQuality: config.compressionJpegQuality
        })
        : await pdf.save({ useObjectStreams: true, updateFieldAppearances: false, objectsPerTick: 50 });
    const output = await writeBinaryOutput({
        userId: job.user_id,
        fileId: file.id,
        jobId: job.id,
        sourceName: file.original_name,
        suffix: '优化结果',
        outputType: 'optimized_pdf',
        bytes,
        pageCount: pdf.getPageCount(),
        quality: {
            complete: true,
            sourceBytes: sourceBytes.length,
            outputBytes: bytes.length,
            savedBytes: Math.max(sourceBytes.length - bytes.length, 0),
            savedRatio: sourceBytes.length ? Math.max(0, (sourceBytes.length - bytes.length) / sourceBytes.length) : 0,
            engine: qpdf.available ? qpdf.version : 'pdf-lib fallback',
            compressionMode: config.compressionMode || 'structure',
            jpegQuality: config.compressionMode === 'images' ? config.compressionJpegQuality : null,
            notice: bytes.length >= sourceBytes.length
                ? '本次优化未减少文件体积，已保留独立输出供核对。'
                : (qpdf.available ? '' : '部署未安装 qpdf，已使用基础结构保存；未执行 qpdf 图像优化。')
        }
    });
    await onProgress?.(90, { processedPages: pdf.getPageCount(), requestedPages: pdf.getPageCount() });
    return { outputs: [output], processedFiles: 1, processedPages: pdf.getPageCount(), requestedPages: pdf.getPageCount() };
}

function parseBlockBbox(block) {
    try {
        return block.bbox_json ? JSON.parse(block.bbox_json) : (block.bbox || []);
    } catch (_error) {
        return [];
    }
}

function bboxToRect(bbox, { sourceWidth, sourceHeight, pdfWidth, pdfHeight }) {
    if (!Array.isArray(bbox) || bbox.length < 2) return null;
    const points = bbox.map(point => Array.isArray(point) ? point : []).filter(point => Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])));
    if (!points.length || !sourceWidth || !sourceHeight || !pdfWidth || !pdfHeight) return null;
    const xs = points.map(point => Number(point[0]));
    const ys = points.map(point => Number(point[1]));
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
        x: Math.max(0, minX / sourceWidth * pdfWidth),
        y: Math.max(0, pdfHeight - maxY / sourceHeight * pdfHeight),
        width: Math.max((maxX - minX) / sourceWidth * pdfWidth, 1),
        height: Math.max((maxY - minY) / sourceHeight * pdfHeight, 8)
    };
}

async function embedImage(pdf, imagePath) {
    const ext = path.extname(imagePath).toLowerCase();
    const raw = await fs.promises.readFile(imagePath);
    if (ext === '.jpg' || ext === '.jpeg') return pdf.embedJpg(raw);
    if (ext === '.png') return pdf.embedPng(raw);
    return pdf.embedPng(await sharp(raw).png().toBuffer());
}

async function createSearchablePdfOutput({ userId, file, job, pages = [], blocks = [] }) {
    if (!pages.length) throw pdfError('暂无可生成可搜索 PDF 的页面结果，请先完成 OCR。', 'OCR_PAGES_MISSING');
    const unaligned = pages.find(page => (page.alignment_status || page.alignmentStatus || 'aligned') !== 'aligned');
    if (unaligned) {
        throw pdfError(`第 ${unaligned.page_number || unaligned.pageNumber || '?'} 页已进行全文修订，文字坐标不再可靠。请完成块级对齐后再生成可搜索 PDF。`, 'EXPORT_ALIGNMENT_REQUIRED', 409);
    }
    const pdf = await PDFDocument.create();
    const font = await getCjkFont(pdf);
    const blocksByPage = new Map();
    blocks.forEach(block => {
        const key = Number(block.page_id || block.pageId || 0);
        const list = blocksByPage.get(key) || [];
        list.push(block);
        blocksByPage.set(key, list);
    });
    for (const pageRow of pages) {
        const imagePath = resolveStoredDocumentPath(pageRow.image_path || pageRow.imagePath);
        if (!imagePath || !await fs.promises.access(imagePath, fs.constants.R_OK).then(() => true).catch(() => false)) {
            throw pdfError(`第 ${pageRow.page_number || pageRow.pageNumber || '?'} 页原始视觉数据缺失，不能生成可搜索 PDF。`, 'SOURCE_VISUAL_MISSING');
        }
        const embedded = await embedImage(pdf, imagePath);
        const sourceWidth = Number(pageRow.pixel_width || pageRow.pixelWidth || pageRow.width || embedded.width);
        const sourceHeight = Number(pageRow.pixel_height || pageRow.pixelHeight || pageRow.height || embedded.height);
        const pdfWidth = Number(pageRow.pdf_width || pageRow.pdfWidth || sourceWidth * 72 / 220) || 595;
        const pdfHeight = Number(pageRow.pdf_height || pageRow.pdfHeight || sourceHeight * 72 / 220) || 842;
        const page = pdf.addPage([pdfWidth, pdfHeight]);
        page.drawImage(embedded, { x: 0, y: 0, width: pdfWidth, height: pdfHeight });
        const pageBlocks = (blocksByPage.get(Number(pageRow.id)) || []).filter(block => (block.alignment_status || block.alignmentStatus || 'aligned') === 'aligned');
        page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
        if (pageBlocks.length) {
            pageBlocks.forEach(block => {
                const text = String(block.text || '').trim();
                if (!text) return;
                const rect = bboxToRect(parseBlockBbox(block), { sourceWidth, sourceHeight, pdfWidth, pdfHeight });
                const size = rect ? Math.min(Math.max(rect.height * 0.72, 6), 32) : 10;
                page.drawText(text.slice(0, 1000), {
                    x: rect ? rect.x : 24,
                    y: rect ? rect.y : Math.max(24, pdfHeight - 48),
                    size,
                    font,
                    maxWidth: rect ? Math.max(rect.width, size * 2) : Math.max(pdfWidth - 48, 100)
                });
            });
        } else if (pageRow.text) {
            String(pageRow.text).split(/\r?\n/).filter(Boolean).slice(0, 120).forEach((line, index) => {
                page.drawText(line.slice(0, 500), { x: 24, y: Math.max(24, pdfHeight - 36 - index * 12), size: 10, font, maxWidth: Math.max(pdfWidth - 48, 100) });
            });
        }
        page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
    }
    const bytes = await pdf.save({ useObjectStreams: true });
    return writeBinaryOutput({
        userId,
        fileId: file.id,
        jobId: job.id,
        sourceName: file.original_name,
        suffix: '可搜索PDF',
        outputType: OUTPUT_TYPES.SEARCHABLE_PDF,
        bytes,
        pageCount: pages.length,
        quality: { complete: true, sourceVisualRequired: true, searchableText: true, contentRevision: Math.max(Number(job.content_revision || job.contentRevision || 1), 1) },
        versionKey: `ocr-r${Math.max(Number(job.content_revision || job.contentRevision || 1), 1)}`
    });
}

function inspectPdfStructure(pdf) {
    let fieldCount = 0;
    let signatureFieldCount = 0;
    let annotationCount = 0;
    try {
        const fields = pdf.getForm().getFields();
        fieldCount = fields.length;
        signatureFieldCount = fields.filter(field => /signature/i.test(field.constructor?.name || '')).length;
    } catch (_error) { /* no AcroForm */ }
    try {
        annotationCount = pdf.getPages().reduce((total, page) => total + (page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.size?.() || 0), 0);
    } catch (_error) { /* informational only */ }
    return {
        forms: fieldCount > 0,
        formFieldCount: fieldCount,
        signatures: signatureFieldCount > 0,
        signatureFieldCount,
        annotations: annotationCount > 0,
        annotationCount,
        bookmarks: Boolean(pdf.catalog.get(PDFName.of('Outlines'))),
        attachments: Boolean(pdf.catalog.get(PDFName.of('Names')))
    };
}

async function preflightPdfFile(file, { maxPages = 300, password = '', userId = 0 } = {}) {
    const summary = {
        fileId: file?.id || null,
        originalName: file?.original_name || file?.originalName || '',
        kind: isPdfExtension(file?.file_ext || file?.fileExt) ? 'pdf' : (isImageExtension(file?.file_ext || file?.fileExt) ? 'image' : 'unsupported'),
        supported: false,
        pageCount: 0,
        warnings: [],
        capabilities: { structural: true, encryptedStructural: getQpdfHealth().available },
        encrypted: false,
        requiresPassword: false,
        structure: null
    };
    try {
        if (summary.kind === 'pdf') {
            const sourcePath = await requirePdfFile(file);
            summary.encrypted = Boolean(isPdfEncrypted(sourcePath));
            summary.requiresPassword = summary.encrypted && !password;
            if (summary.requiresPassword) {
                summary.supported = false;
                summary.code = getQpdfHealth().available ? 'PDF_PASSWORD_REQUIRED' : 'PDF_ENCRYPTION_UNSUPPORTED';
                summary.warnings.push(getQpdfHealth().available ? '该文件已加密，提交授权密码后可进行预检和处理。' : '该文件已加密，当前部署未安装 qpdf，无法进行结构处理。');
                return summary;
            }
            const pdf = await loadPdf(file, { password, userId });
            summary.pageCount = pdf.getPageCount();
            summary.supported = summary.pageCount > 0 && summary.pageCount <= normalizePageLimit(maxPages);
            if (summary.pageCount > normalizePageLimit(maxPages)) summary.warnings.push(`文件共 ${summary.pageCount} 页，超过当前单次 ${normalizePageLimit(maxPages)} 页限制。`);
            const first = pdf.getPage(0);
            summary.pageSize = { width: first.getWidth(), height: first.getHeight(), unit: 'pt' };
            summary.structure = inspectPdfStructure(pdf);
            if (summary.structure.signatures) summary.warnings.push('检测到签名字段。对页面或内容做任何改写都会使现有数字签名失效。');
            if (summary.structure.forms) summary.warnings.push(`检测到 ${summary.structure.formFieldCount} 个表单字段。结构编辑前请确认交互行为。`);
        } else if (summary.kind === 'image') {
            const filePath = await requireImageFile(file);
            const image = await sharp(filePath).metadata();
            summary.pageCount = 1;
            summary.supported = true;
            summary.pageSize = { width: Number(image.width || 0), height: Number(image.height || 0), unit: 'px' };
        } else {
            summary.warnings.push('文件类型不受 PDF 工具支持。');
        }
    } catch (error) {
        summary.code = error.code || 'PREFLIGHT_FAILED';
        summary.warnings.push(String(error.message || '文件预检失败。'));
    }
    return summary;
}

async function getPdfPageMetrics(file, options = {}) {
    const pdf = await loadPdf(file, options);
    return pdf.getPages().map((page, index) => ({
        pageNumber: index + 1,
        pdfWidth: page.getWidth(),
        pdfHeight: page.getHeight(),
        rotation: page.getRotation().angle || 0,
        cropBox: page.getCropBox()
    }));
}

function getPdfToolCapabilities() {
    const font = verifyCjkFont();
    const qpdf = getQpdfHealth();
    const verapdf = getVeraPdfHealth();
    return {
        operations: Object.entries(PDF_OPERATION_META).map(([id, meta]) => ({
            id,
            ...meta,
            available: !(meta.requiresQpdf && !qpdf.available) && !(meta.requiresVeraPdf && !verapdf.available),
            unavailableReason: meta.requiresQpdf && !qpdf.available
                ? (qpdf.message || '当前部署未安装 qpdf。')
                : (meta.requiresVeraPdf && !verapdf.available ? (verapdf.message || '当前部署未安装 veraPDF。') : '')
        })),
        presets: [
            { id: 'merge-submission', label: '材料合并归档', operation: PDF_TOOL_OPERATIONS.MERGE, config: {} },
            { id: 'scan-searchable', label: '扫描件生成可搜索 PDF', operation: PDF_TOOL_OPERATIONS.SEARCHABLE_PDF, config: { dpi: 220, maxToolPages: 100 } },
            { id: 'internal-watermark', label: '内部材料水印', operation: PDF_TOOL_OPERATIONS.WATERMARK, config: { watermarkText: '内部资料', watermarkPosition: 'center', watermarkOpacity: 0.18, watermarkRotate: -45 } },
            { id: 'formal-page-numbers', label: '正式材料页码', operation: PDF_TOOL_OPERATIONS.PAGE_NUMBERS, config: { pageNumberPosition: 'bottom-center', pageNumberStart: 1, skipCover: true } },
            { id: 'archive-optimize', label: '归档前结构优化', operation: PDF_TOOL_OPERATIONS.COMPRESS, config: { compressionMode: 'structure' } },
            { id: 'secure-redaction', label: '永久脱敏（栅格化）', operation: PDF_TOOL_OPERATIONS.REDACT, config: {} }
        ],
        limits: { maxFiles: 20, maxPages: 300, maxImagePixels: MAX_IMAGE_PIXELS, maxBufferBytes: MAX_PDF_BUFFER_BYTES },
        engines: {
            structuralPdf: { available: true, encryptedInput: qpdf.available, message: qpdf.available ? 'qpdf 已就绪，可处理授权密码的结构操作。' : '加密 PDF 的结构处理当前不可用。' },
            qpdf: { available: qpdf.available, version: qpdf.version || '', message: qpdf.message || '' },
            veraPdf: { available: verapdf.available, version: verapdf.version || '', message: verapdf.message || '' },
            cjkFont: { available: font.available, message: font.reason },
            ocr: { requiredForSearchablePdf: true }
        }
    };
}

const advancedOperations = createAdvancedPdfOperations({
    assertPdfPageCount,
    baseName,
    ensureNotCancelled,
    getCjkFont,
    loadPdf,
    pdfError,
    pdfLoadOptions,
    requirePdfFile,
    savePdfOutput,
    writeBinaryOutput
});

async function processPdfToolOperation({ job, file, files = [], config = {}, onProgress, isCancelled }) {
    const operation = requirePdfOperation(config.operation);
    const sourceFiles = files.length ? files : [file].filter(Boolean);
    const input = assertPdfInputFiles({ operation, files: sourceFiles, mode: normalizePdfMode(config.mode) });
    await ensureNotCancelled(isCancelled);
    await onProgress?.(10, { operation, stage: 'transforming', requestedFiles: input.files.length });
    const context = { job, file, files: input.files, config, onProgress, isCancelled };
    if (operation === PDF_TOOL_OPERATIONS.SPLIT) return { operation, ...(await splitPdf(context)) };
    if (operation === PDF_TOOL_OPERATIONS.MERGE) return { operation, ...(await mergePdf(context)) };
    if (operation === PDF_TOOL_OPERATIONS.ROTATE) return { operation, ...(await rotatePdf(context)) };
    if (operation === PDF_TOOL_OPERATIONS.DELETE_PAGES) return { operation, ...(await deletePdfPages(context)) };
    if (operation === PDF_TOOL_OPERATIONS.REORDER) return { operation, ...(await reorderPdf(context)) };
    if (operation === PDF_TOOL_OPERATIONS.PAGE_PLAN) return { operation, ...(await applyPagePlan(context)) };
    if (operation === PDF_TOOL_OPERATIONS.PDF_TO_IMAGES) return { operation, ...(await pdfToImages(context)) };
    if (operation === PDF_TOOL_OPERATIONS.IMAGES_TO_PDF) return { operation, ...(await imagesToPdf(context)) };
    if (operation === PDF_TOOL_OPERATIONS.WATERMARK) return { operation, ...(await watermarkPdf(context)) };
    if (operation === PDF_TOOL_OPERATIONS.PAGE_NUMBERS) return { operation, ...(await pageNumbersPdf(context)) };
    if (operation === PDF_TOOL_OPERATIONS.CROP) return { operation, ...(await cropPdf(context)) };
    if (operation === PDF_TOOL_OPERATIONS.INSERT_BLANK) return { operation, ...(await insertBlankPdf(context)) };
    if (operation === PDF_TOOL_OPERATIONS.COMPRESS) return { operation, ...(await compressPdf(context)) };
    if (operation === PDF_TOOL_OPERATIONS.PROTECT) return { operation, ...(await advancedOperations.protectPdfOutput(context)) };
    if (operation === PDF_TOOL_OPERATIONS.REDACT) return { operation, ...(await advancedOperations.redactPdf(context)) };
    if (operation === PDF_TOOL_OPERATIONS.FILL_FORM) return { operation, ...(await advancedOperations.fillPdfForm(context)) };
    if (operation === PDF_TOOL_OPERATIONS.ANNOTATE) return { operation, ...(await advancedOperations.annotatePdf(context)) };
    if (operation === PDF_TOOL_OPERATIONS.PDFA_VALIDATE) return { operation, ...(await advancedOperations.validatePdfAOutput(context)) };
    if (operation === PDF_TOOL_OPERATIONS.EXPORT_DOCX) return { operation, ...(await advancedOperations.exportPdfDocx(context)) };
    if (operation === PDF_TOOL_OPERATIONS.EXPORT_XLSX) return { operation, ...(await advancedOperations.exportPdfXlsx(context)) };
    if (operation === PDF_TOOL_OPERATIONS.COMPARE) return { operation, ...(await advancedOperations.comparePdf(context)) };
    if (operation === PDF_TOOL_OPERATIONS.SEARCHABLE_PDF) throw pdfError('可搜索 PDF 需要通过 OCR 处理链路生成。', 'OCR_REQUIRED', 409);
    return { operation, ...(await extractPdfTextOutput(context)) };
}

module.exports = {
    PDF_OPERATION_META,
    PDF_TOOL_OPERATIONS,
    assertPdfInputFiles,
    createSearchablePdfOutput,
    getPdfOperationMeta,
    getPdfToolCapabilities,
    getPdfPageMetrics,
    normalizePdfOperation,
    parsePageOrder,
    parsePageSelection,
    preflightPdfFile,
    processPdfToolOperation,
    requirePdfOperation
};
