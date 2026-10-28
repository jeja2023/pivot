const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const { extractDocumentText, extractPdfTextByPage, renderPdfPages, truncateExtractedText } = require('../../document-text');
const { normalizeEngine, recognizePage } = require('./ocr');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

function isImageDocument(filename = '') {
    return IMAGE_EXTENSIONS.has(path.extname(String(filename || '')).toLowerCase());
}

function normalizeOcrOptions(options = {}) {
    return {
        engine: normalizeEngine(options.engine || process.env.DOCUMENT_PROCESSING_OCR_ENGINE || 'http'),
        language: options.language || options.lang || 'ch',
        timeoutMs: Math.min(Math.max(Number.parseInt(options.timeoutMs || process.env.DOCUMENT_PROCESSING_OCR_TIMEOUT_MS || process.env.OCR_SERVICE_TIMEOUT_MS || '120000', 10) || 120000, 5000), 600000),
        password: options.password || '',
        maxOcrPages: Math.min(Math.max(Number.parseInt(options.maxOcrPages, 10) || 10, 1), 100),
        desiredWidth: Math.min(Math.max(Number.parseInt(options.desiredWidth, 10) || 1600, 800), 3200)
    };
}

function resultToText(result) {
    const text = String(result?.text || '').trim();
    if (text) return text;
    return (result?.blocks || [])
        .map(block => String(block?.text || '').trim())
        .filter(Boolean)
        .join('\n')
        .trim();
}

async function ocrImageFile(filePath, options = {}) {
    const result = await recognizePage(filePath, normalizeOcrOptions(options));
    return resultToText(result);
}

async function ocrPdfFile(filePath, options = {}) {
    const safe = normalizeOcrOptions(options);
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pivot-pdf-ocr-'));
    const imagePaths = [];
    try {
        const pages = await renderPdfPages(filePath, {
            password: safe.password,
            maxPages: safe.maxOcrPages,
            desiredWidth: safe.desiredWidth
        });
        const texts = [];
        for (const page of pages) {
            const pageNo = Number(page.page || texts.length + 1);
            const imagePath = path.join(tmpDir, `page-${String(pageNo).padStart(4, '0')}.png`);
            await fs.promises.writeFile(imagePath, page.data);
            imagePaths.push(imagePath);
            const text = await ocrImageFile(imagePath, safe);
            if (text) texts.push(text);
        }
        return texts.join('\n\n').trim();
    } finally {
        await Promise.all(imagePaths.map(imagePath => fs.promises.rm(imagePath, { force: true }).catch(() => {})));
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
}

async function extractPdfTextWithPageFallback(filePath, options = {}) {
    const safe = normalizeOcrOptions(options);
    const nativePages = await (options.extractPdfTextByPage || extractPdfTextByPage)(filePath, { password: safe.password });
    const cachedPages = options.cachedOcrPages instanceof Map ? options.cachedOcrPages : new Map();
    const refreshPages = options.refreshOcrPages instanceof Set ? options.refreshOcrPages : new Set();
    const missingPageNumbers = nativePages.filter(page => !String(page.text || '').trim() && (!String(cachedPages.get(page.pageNumber) || '').trim() || refreshPages.has(page.pageNumber))).map(page => page.pageNumber);
    const plannedOcr = new Set(missingPageNumbers.slice(0, safe.maxOcrPages));
    const tmpDir = missingPageNumbers.length ? await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pivot-mixed-pdf-ocr-')) : '';
    const imagePaths = [];
    try {
        const pages = [];
        for (const nativePage of nativePages) {
            const originalText = String(nativePage.text || '').trim();
            if (originalText) {
                pages.push({ pageNumber: nativePage.pageNumber, text: originalText, source: 'native' });
                continue;
            }
            const cachedText = String(cachedPages.get(nativePage.pageNumber) || '').replace(/\r\n?/g, '\n').trim();
            if (cachedText && !(refreshPages.has(nativePage.pageNumber) && plannedOcr.has(nativePage.pageNumber))) {
                pages.push({ pageNumber: nativePage.pageNumber, text: cachedText, source: 'ocr' });
                continue;
            }
            if (!plannedOcr.has(nativePage.pageNumber)) {
                pages.push({ pageNumber: nativePage.pageNumber, text: '', source: 'omitted', error: '超出 OCR 页数上限' });
                continue;
            }
            try {
                const rendered = await (options.renderPdfPages || renderPdfPages)(filePath, { password: safe.password, desiredWidth: safe.desiredWidth, first: nativePage.pageNumber, last: nativePage.pageNumber, maxPages: 1 });
                if (!rendered[0]?.data) throw new Error('页面渲染失败');
                const imagePath = path.join(tmpDir, `page-${String(nativePage.pageNumber).padStart(4, '0')}.png`);
                await fs.promises.writeFile(imagePath, rendered[0].data);
                imagePaths.push(imagePath);
                let text, location = null;
                if (options.ocrImageFile) text = await options.ocrImageFile(imagePath, safe);
                else {
                    const result = await recognizePage(imagePath, safe);
                    text = resultToText(result);
                    const dimensions = await sharp(rendered[0].data).metadata();
                    location = { width: dimensions.width, height: dimensions.height, blocks: (result.blocks || []).slice(0, 10000).map(block => ({ text: String(block.text || '').slice(0, 1000), bbox: block.bbox })) };
                }
                text = String(text || '').replace(/\r\n?/g, '\n').trim();
                if (text && options.onOcrPage) await options.onOcrPage(nativePage.pageNumber, text, location);
                pages.push({ pageNumber: nativePage.pageNumber, text: text || cachedText, source: text || cachedText ? 'ocr' : 'unavailable', ...(text ? {} : { error: 'OCR 未识别到文字' }) });
            } catch (error) {
                pages.push({ pageNumber: nativePage.pageNumber, text: cachedText, source: cachedText ? 'ocr' : 'unavailable', error: String(error.message || error).slice(0, 300) });
            }
        }
        const omittedPages = pages.filter(page => page.source === 'omitted').map(page => page.pageNumber);
        return {
            pages,
            sourcePageCount: nativePages.length,
            plannedPageCount: nativePages.length - omittedPages.length,
            omittedPages,
            coverageComplete: pages.every(page => page.source !== 'unavailable' && page.source !== 'omitted')
        };
    } finally {
        await Promise.all(imagePaths.map(imagePath => fs.promises.rm(imagePath, { force: true }).catch(() => {})));
        if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
}

async function extractDocumentTextWithOcrFallback(filePath, mimeType = '', originalName = '', options = {}) {
    const name = originalName || filePath || '';
    const ext = path.extname(String(name)).toLowerCase();
    if (isImageDocument(name)) {
        return ocrImageFile(filePath, options);
    }

    if (ext === '.pdf' || String(mimeType || '').toLowerCase() === 'application/pdf') {
        if (options.ocrFallback === false) return extractDocumentText(filePath, mimeType, name, options);
        const result = await extractPdfTextWithPageFallback(filePath, options);
        const body = result.pages.map(page => String(page.text || '').trim()).filter(Boolean).join('\n\n').trim();
        options.onCoverage?.(result);
        return body;
    }
    const text = await extractDocumentText(filePath, mimeType, name, options);
    if (String(text || '').trim() || options.ocrFallback === false) return text || '';
    return text || '';
}

module.exports = {
    IMAGE_EXTENSIONS,
    extractDocumentTextWithOcrFallback,
    extractPdfTextWithPageFallback,
    isImageDocument,
    ocrImageFile,
    ocrPdfFile,
    truncateExtractedText
};
