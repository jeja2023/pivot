const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');

const { extractDocumentText, truncateExtractedText } = require('../../../document-text');
const { getKnowledgeLimits } = require('../../resource-limits');
const { OUTPUT_TYPES, isImageExtension, isPdfExtension } = require('../constants');
const { createTextOutputs, registerOutput, serializeOutput } = require('../exporters');
const { renderPdfPagesToFiles } = require('../renderers');
const { buildManagedPath, outputsRoot, resolveStoredDocumentPath } = require('../paths');

const PDF_TOOL_OPERATIONS = Object.freeze({
    SPLIT: 'split',
    MERGE: 'merge',
    ROTATE: 'rotate',
    DELETE_PAGES: 'delete_pages',
    REORDER: 'reorder',
    EXTRACT_TEXT: 'extract_text',
    PDF_TO_IMAGES: 'pdf_to_images',
    IMAGES_TO_PDF: 'images_to_pdf',
    SEARCHABLE_PDF: 'searchable_pdf'
});

function normalizePdfOperation(value) {
    const operation = String(value || '').trim().toLowerCase();
    if (operation === 'delete' || operation === 'remove_pages') return PDF_TOOL_OPERATIONS.DELETE_PAGES;
    if (operation === 'images-to-pdf') return PDF_TOOL_OPERATIONS.IMAGES_TO_PDF;
    if (operation === 'pdf-to-images') return PDF_TOOL_OPERATIONS.PDF_TO_IMAGES;
    if (Object.values(PDF_TOOL_OPERATIONS).includes(operation)) return operation;
    return PDF_TOOL_OPERATIONS.EXTRACT_TEXT;
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

function getStoredPathForFile(file) {
    const target = resolveStoredDocumentPath(file?.file_path);
    if (!target || !fs.existsSync(target)) {
        const error = new Error('原始文件不存在，请重新上传后再处理。');
        error.status = 404;
        throw error;
    }
    return target;
}

function requirePdfFile(file) {
    if (!file || !isPdfExtension(file.file_ext)) {
        const error = new Error('该操作仅支持 PDF 文件。');
        error.status = 400;
        throw error;
    }
    return getStoredPathForFile(file);
}

function requireImageFile(file) {
    if (!file || !isImageExtension(file.file_ext)) {
        const error = new Error('图片转 PDF 仅支持图片文件。');
        error.status = 400;
        throw error;
    }
    return getStoredPathForFile(file);
}

function parsePageSelection(value, pageCount, { defaultAll = true } = {}) {
    const text = String(value || '').trim();
    if (!text) return defaultAll ? Array.from({ length: pageCount }, (_item, index) => index) : [];
    const indexes = new Set();
    text.split(/[，,;；\s]+/).filter(Boolean).forEach(part => {
        const match = part.match(/^(\d+)(?:-(\d+))?$/);
        if (!match) return;
        const start = Math.max(1, Number.parseInt(match[1], 10));
        const end = Math.min(pageCount, Number.parseInt(match[2] || match[1], 10));
        for (let page = Math.min(start, end); page <= Math.max(start, end); page += 1) {
            if (page >= 1 && page <= pageCount) indexes.add(page - 1);
        }
    });
    return Array.from(indexes).sort((a, b) => a - b);
}

function parsePageOrder(value, pageCount) {
    const text = String(value || '').trim();
    if (!text) return [];
    return text.split(/[，,;；\s]+/)
        .map(item => Number.parseInt(item, 10))
        .filter(page => Number.isSafeInteger(page) && page >= 1 && page <= pageCount)
        .map(page => page - 1);
}

function clampToolPageCount(count, limit = 100) {
    const max = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 300);
    if (count > max) {
        const error = new Error(`单次 PDF 工具处理最多支持 ${max} 页，请缩小页码范围后重试。`);
        error.status = 400;
        throw error;
    }
}

async function loadPdf(file, config = {}) {
    const filePath = requirePdfFile(file);
    const bytes = fs.readFileSync(filePath);
    return PDFDocument.load(bytes, {
        ignoreEncryption: false,
        password: config.password || undefined
    });
}

async function writeBinaryOutput({ userId, fileId, jobId, sourceName, suffix, outputType = 'pdf', bytes, mimeType = 'application/pdf', extension = '.pdf' }) {
    const diskName = `${jobId}-${sanitizeOutputName(outputType)}-${crypto.randomUUID()}${extension}`;
    const targetPath = buildManagedPath(outputsRoot, userId, diskName);
    fs.writeFileSync(targetPath, Buffer.from(bytes));
    const fileName = `${baseName(sourceName)}-${suffix}${extension}`;
    return serializeOutput(await registerOutput({
        userId,
        fileId,
        jobId,
        outputType,
        filePath: targetPath,
        fileName,
        mimeType
    }));
}

async function splitPdf({ job, file, config, onProgress }) {
    const source = await loadPdf(file, config);
    const pageCount = source.getPageCount();
    const indexes = parsePageSelection(config.pages || config.pageRanges, pageCount, { defaultAll: true });
    clampToolPageCount(indexes.length, config.maxToolPages);
    if (!indexes.length) throw new Error('未找到可拆分的 PDF 页。');
    const outputs = [];
    for (let i = 0; i < indexes.length; i += 1) {
        const target = await PDFDocument.create();
        const [page] = await target.copyPages(source, [indexes[i]]);
        target.addPage(page);
        const bytes = await target.save();
        outputs.push(await writeBinaryOutput({
            userId: job.user_id,
            fileId: file.id,
            jobId: job.id,
            sourceName: file.original_name,
            suffix: `第${indexes[i] + 1}页`,
            outputType: 'split_pdf',
            bytes
        }));
        if (onProgress) await onProgress(20 + Math.floor(((i + 1) / indexes.length) * 70), { processedPages: i + 1 });
    }
    return { outputs, processedPages: indexes.length };
}

async function mergePdf({ job, file, files, config, onProgress }) {
    const pdfFiles = files.filter(item => isPdfExtension(item.file_ext));
    if (pdfFiles.length < 2) throw new Error('PDF 合并至少需要上传两个 PDF 文件。');
    const target = await PDFDocument.create();
    let copiedPages = 0;
    for (let i = 0; i < pdfFiles.length; i += 1) {
        const source = await loadPdf(pdfFiles[i], config);
        const indexes = parsePageSelection('', source.getPageCount(), { defaultAll: true });
        const copied = await target.copyPages(source, indexes);
        copied.forEach(page => target.addPage(page));
        copiedPages += copied.length;
        if (onProgress) await onProgress(15 + Math.floor(((i + 1) / pdfFiles.length) * 70), { processedFiles: i + 1, processedPages: copiedPages });
    }
    if (copiedPages === 0) throw new Error('未找到可合并的 PDF 页面。');
    const bytes = await target.save();
    return {
        outputs: [await writeBinaryOutput({
            userId: job.user_id,
            fileId: file.id,
            jobId: job.id,
            sourceName: file.original_name,
            suffix: '合并结果',
            outputType: 'merged_pdf',
            bytes
        })],
        processedFiles: pdfFiles.length,
        processedPages: copiedPages
    };
}

async function rotatePdf({ job, file, config, onProgress }) {
    const source = await loadPdf(file, config);
    const target = await PDFDocument.create();
    const indexes = parsePageSelection('', source.getPageCount(), { defaultAll: true });
    const selected = new Set(parsePageSelection(config.pages || config.pageRanges, source.getPageCount(), { defaultAll: true }));
    clampToolPageCount(indexes.length, config.maxToolPages);
    const rotateDegrees = Number.parseInt(config.rotateDegrees, 10);
    const delta = [90, 180, 270, -90].includes(rotateDegrees) ? rotateDegrees : 90;
    const copied = await target.copyPages(source, indexes);
    copied.forEach((page, index) => {
        if (selected.has(index)) {
            const current = page.getRotation().angle || 0;
            page.setRotation(degrees((current + delta + 360) % 360));
        }
        target.addPage(page);
    });
    if (onProgress) await onProgress(90, { processedPages: copied.length });
    const bytes = await target.save();
    return {
        outputs: [await writeBinaryOutput({
            userId: job.user_id,
            fileId: file.id,
            jobId: job.id,
            sourceName: file.original_name,
            suffix: '旋转结果',
            outputType: 'rotated_pdf',
            bytes
        })],
        processedPages: copied.length
    };
}

async function deletePdfPages({ job, file, config, onProgress }) {
    const source = await loadPdf(file, config);
    const pageCount = source.getPageCount();
    const selected = new Set(parsePageSelection(config.pages || config.pageRanges, pageCount, { defaultAll: false }));
    if (!selected.size) throw new Error('请填写需要删除的页码范围。');
    const keep = Array.from({ length: pageCount }, (_item, index) => index).filter(index => !selected.has(index));
    if (!keep.length) throw new Error('不能删除 PDF 的全部页面。');
    clampToolPageCount(keep.length, config.maxToolPages);
    const target = await PDFDocument.create();
    const copied = await target.copyPages(source, keep);
    copied.forEach(page => target.addPage(page));
    if (onProgress) await onProgress(90, { processedPages: copied.length, removedPages: selected.size });
    const bytes = await target.save();
    return {
        outputs: [await writeBinaryOutput({
            userId: job.user_id,
            fileId: file.id,
            jobId: job.id,
            sourceName: file.original_name,
            suffix: '删页结果',
            outputType: 'deleted_pages_pdf',
            bytes
        })],
        processedPages: copied.length,
        removedPages: selected.size
    };
}

async function reorderPdf({ job, file, config, onProgress }) {
    const source = await loadPdf(file, config);
    const order = parsePageOrder(config.pageOrder || config.pages, source.getPageCount());
    if (!order.length) throw new Error('请填写重排后的页码顺序，例如 3,1,2。');
    clampToolPageCount(order.length, config.maxToolPages);
    const target = await PDFDocument.create();
    const copied = await target.copyPages(source, order);
    copied.forEach(page => target.addPage(page));
    if (onProgress) await onProgress(90, { processedPages: copied.length });
    const bytes = await target.save();
    return {
        outputs: [await writeBinaryOutput({
            userId: job.user_id,
            fileId: file.id,
            jobId: job.id,
            sourceName: file.original_name,
            suffix: '重排结果',
            outputType: 'reordered_pdf',
            bytes
        })],
        processedPages: copied.length
    };
}

async function extractPdfTextOutput({ job, file, config }) {
    const filePath = requirePdfFile(file);
    const text = truncateExtractedText(
        await extractDocumentText(filePath, '', file.original_name, { password: config.password }),
        getKnowledgeLimits().extractMaxChars
    );
    const outputs = createTextOutputs({
        userId: job.user_id,
        file,
        job,
        text,
        pages: [],
        blocks: [],
        formats: [OUTPUT_TYPES.TEXT, OUTPUT_TYPES.MARKDOWN, OUTPUT_TYPES.JSON]
    });
    return { outputs, textLength: String(text || '').length };
}

async function pdfToImages({ job, file, config, onProgress }) {
    const filePath = requirePdfFile(file);
    const rendered = await renderPdfPagesToFiles({
        filePath,
        userId: job.user_id,
        jobId: job.id,
        options: {
            password: config.password,
            maxPages: config.maxRenderPages || config.maxToolPages || 20,
            desiredWidth: Math.round((Number(config.dpi) || 180) * 6.4)
        }
    });
    if (!rendered.length) throw new Error('PDF 页面渲染失败，请确认文件未加密且格式正确。');
    const outputs = await Promise.all(rendered.map(async (page, index) => {
        if (onProgress) await onProgress(20 + Math.floor(((index + 1) / rendered.length) * 70), { processedPages: index + 1 });
        const filePath = resolveStoredDocumentPath(page.imagePath);
        return serializeOutput(await registerOutput({
            userId: job.user_id,
            fileId: file.id,
            jobId: job.id,
            outputType: 'page_image',
            filePath,
            fileName: `${baseName(file.original_name)}-第${page.pageNumber}页.png`,
            mimeType: 'image/png'
        }));
    }));
    return { outputs, processedPages: rendered.length };
}

async function readImageForPdf(file) {
    const filePath = requireImageFile(file);
    const ext = String(file.file_ext || '').toLowerCase();
    const raw = fs.readFileSync(filePath);
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') return { bytes: raw, ext };
    const converted = await sharp(raw).png().toBuffer();
    return { bytes: converted, ext: '.png' };
}

async function imagesToPdf({ job, file, files, onProgress }) {
    const imageFiles = files.filter(item => isImageExtension(item.file_ext));
    if (!imageFiles.length) throw new Error('请上传至少一张图片用于生成 PDF。');
    clampToolPageCount(imageFiles.length, 100);
    const pdf = await PDFDocument.create();
    for (let i = 0; i < imageFiles.length; i += 1) {
        const image = await readImageForPdf(imageFiles[i]);
        const embedded = image.ext === '.jpg' || image.ext === '.jpeg'
            ? await pdf.embedJpg(image.bytes)
            : await pdf.embedPng(image.bytes);
        const page = pdf.addPage([embedded.width, embedded.height]);
        page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
        if (onProgress) await onProgress(15 + Math.floor(((i + 1) / imageFiles.length) * 75), { processedFiles: i + 1 });
    }
    const bytes = await pdf.save();
    return {
        outputs: [await writeBinaryOutput({
            userId: job.user_id,
            fileId: file.id,
            jobId: job.id,
            sourceName: file.original_name,
            suffix: '图片转PDF',
            outputType: 'images_pdf',
            bytes
        })],
        processedFiles: imageFiles.length
    };
}

function bboxToRect(bbox, pageHeight) {
    if (!Array.isArray(bbox) || bbox.length < 2) return null;
    const points = bbox
        .map(point => Array.isArray(point) ? point : [])
        .filter(point => Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])));
    if (!points.length) return null;
    const xs = points.map(point => Number(point[0]));
    const ys = points.map(point => Number(point[1]));
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
        x: minX,
        y: pageHeight - maxY,
        width: Math.max(maxX - minX, 1),
        height: Math.max(maxY - minY, 8)
    };
}

function parseBlockBbox(block) {
    try {
        return block.bbox_json ? JSON.parse(block.bbox_json) : (block.bbox || []);
    } catch (_err) {
        return [];
    }
}

async function embedImage(pdf, imagePath) {
    const ext = path.extname(imagePath).toLowerCase();
    const raw = fs.readFileSync(imagePath);
    if (ext === '.jpg' || ext === '.jpeg') return pdf.embedJpg(raw);
    if (ext === '.png') return pdf.embedPng(raw);
    const png = await sharp(raw).png().toBuffer();
    return pdf.embedPng(png);
}

async function createSearchablePdfOutput({ userId, file, job, pages = [], blocks = [] }) {
    if (!pages.length) {
        const error = new Error('暂无可生成可搜索 PDF 的页面结果，请先完成 OCR。');
        error.status = 400;
        throw error;
    }
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const blocksByPage = new Map();
    blocks.forEach(block => {
        const key = Number(block.page_id || block.pageId || 0);
        const list = blocksByPage.get(key) || [];
        list.push(block);
        blocksByPage.set(key, list);
    });

    for (const pageRow of pages) {
        const imagePath = resolveStoredDocumentPath(pageRow.image_path || pageRow.imagePath);
        const pageBlocks = blocksByPage.get(Number(pageRow.id)) || [];
        let width = Number(pageRow.width || 0) || 595;
        let height = Number(pageRow.height || 0) || 842;
        const page = pdf.addPage([width, height]);
        if (imagePath && fs.existsSync(imagePath)) {
            const embedded = await embedImage(pdf, imagePath);
            width = Number(pageRow.width || 0) || embedded.width;
            height = Number(pageRow.height || 0) || embedded.height;
            page.setSize(width, height);
            page.drawImage(embedded, { x: 0, y: 0, width, height });
        }
        if (pageBlocks.length) {
            pageBlocks.forEach(block => {
                const text = String(block.text || '').trim();
                if (!text) return;
                const rect = bboxToRect(parseBlockBbox(block), height);
                const size = rect ? Math.min(Math.max(rect.height * 0.72, 6), 24) : 10;
                page.drawText(text.slice(0, 1000), {
                    x: rect ? rect.x : 24,
                    y: rect ? rect.y : Math.max(24, height - 48),
                    size,
                    font,
                    color: rgb(0, 0, 0),
                    opacity: 0.01,
                    maxWidth: rect ? Math.max(rect.width, size * 2) : Math.max(width - 48, 100)
                });
            });
        } else if (pageRow.text) {
            const lines = String(pageRow.text).split(/\r?\n/).filter(Boolean).slice(0, 120);
            lines.forEach((line, index) => {
                page.drawText(line.slice(0, 500), {
                    x: 24,
                    y: Math.max(24, height - 36 - index * 12),
                    size: 10,
                    font,
                    color: rgb(0, 0, 0),
                    opacity: 0.01,
                    maxWidth: Math.max(width - 48, 100)
                });
            });
        }
    }

    const bytes = await pdf.save();
    return await writeBinaryOutput({
        userId,
        fileId: file.id,
        jobId: job.id,
        sourceName: file.original_name,
        suffix: '可搜索PDF',
        outputType: OUTPUT_TYPES.SEARCHABLE_PDF,
        bytes
    });
}

async function processPdfToolOperation({ job, file, files = [], config = {}, onProgress }) {
    const operation = normalizePdfOperation(config.operation);
    const sourceFiles = files.length ? files : [file].filter(Boolean);
    onProgress?.(10, { operation });
    if (operation === PDF_TOOL_OPERATIONS.SPLIT) return { operation, ...(await splitPdf({ job, file, config, onProgress })) };
    if (operation === PDF_TOOL_OPERATIONS.MERGE) return { operation, ...(await mergePdf({ job, file, files: sourceFiles, config, onProgress })) };
    if (operation === PDF_TOOL_OPERATIONS.ROTATE) return { operation, ...(await rotatePdf({ job, file, config, onProgress })) };
    if (operation === PDF_TOOL_OPERATIONS.DELETE_PAGES) return { operation, ...(await deletePdfPages({ job, file, config, onProgress })) };
    if (operation === PDF_TOOL_OPERATIONS.REORDER) return { operation, ...(await reorderPdf({ job, file, config, onProgress })) };
    if (operation === PDF_TOOL_OPERATIONS.PDF_TO_IMAGES) return { operation, ...(await pdfToImages({ job, file, config, onProgress })) };
    if (operation === PDF_TOOL_OPERATIONS.IMAGES_TO_PDF) return { operation, ...(await imagesToPdf({ job, file, files: sourceFiles, config, onProgress })) };
    if (operation === PDF_TOOL_OPERATIONS.SEARCHABLE_PDF) {
        const error = new Error('可搜索 PDF 请先通过文字识别任务完成 OCR 后，在识别结果中导出。');
        error.status = 409;
        throw error;
    }
    return { operation, ...(await extractPdfTextOutput({ job, file, config })) };
}

module.exports = {
    PDF_TOOL_OPERATIONS,
    createSearchablePdfOutput,
    normalizePdfOperation,
    parsePageOrder,
    parsePageSelection,
    processPdfToolOperation
};
