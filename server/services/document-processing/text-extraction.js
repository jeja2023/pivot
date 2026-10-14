const fs = require('fs');
const os = require('os');
const path = require('path');

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
    const nativePages = await extractPdfTextByPage(filePath, { password: safe.password });
    const pageLimit = Math.min(safe.maxOcrPages, nativePages.length);
    const selectedPages = nativePages.slice(0, pageLimit);
    const missingPageNumbers = selectedPages.filter(page => !String(page.text || '').trim()).map(page => page.pageNumber);
    const rendered = missingPageNumbers.length
        ? await renderPdfPages(filePath, { password: safe.password, desiredWidth: safe.desiredWidth, maxPages: pageLimit })
        : [];
    const renderedByPage = new Map(rendered.map(page => [Number(page.page), page]));
    const tmpDir = missingPageNumbers.length ? await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pivot-mixed-pdf-ocr-')) : '';
    const imagePaths = [];
    try {
        const pages = [];
        for (const nativePage of selectedPages) {
            const originalText = String(nativePage.text || '').trim();
            if (originalText) {
                pages.push({ pageNumber: nativePage.pageNumber, text: originalText, source: 'native' });
                continue;
            }
            const renderedPage = renderedByPage.get(nativePage.pageNumber);
            if (!renderedPage?.data) {
                pages.push({ pageNumber: nativePage.pageNumber, text: '', source: 'unavailable', error: '页面渲染失败' });
                continue;
            }
            const imagePath = path.join(tmpDir, `page-${String(nativePage.pageNumber).padStart(4, '0')}.png`);
            await fs.promises.writeFile(imagePath, renderedPage.data);
            imagePaths.push(imagePath);
            const text = await ocrImageFile(imagePath, safe);
            pages.push({ pageNumber: nativePage.pageNumber, text, source: 'ocr' });
        }
        const omittedPages = nativePages.slice(pageLimit).map(page => page.pageNumber);
        return {
            pages,
            sourcePageCount: nativePages.length,
            plannedPageCount: selectedPages.length,
            omittedPages,
            coverageComplete: omittedPages.length === 0 && pages.every(page => page.source !== 'unavailable')
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
        if (result.omittedPages.length) {
            return `${body}${body ? '\n\n' : ''}[第 ${result.omittedPages.join(', ')} 页未在当前 OCR 页数上限内处理]`;
        }
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
