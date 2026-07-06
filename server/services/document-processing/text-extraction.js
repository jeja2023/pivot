const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractDocumentText, renderPdfPages, truncateExtractedText } = require('../../document-text');
const { recognizePage } = require('./ocr');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

function isImageDocument(filename = '') {
    return IMAGE_EXTENSIONS.has(path.extname(String(filename || '')).toLowerCase());
}

function normalizeOcrOptions(options = {}) {
    return {
        engine: options.engine || process.env.DOCUMENT_PROCESSING_OCR_ENGINE || 'paddle',
        language: options.language || options.lang || 'ch',
        timeoutMs: Math.max(5000, Number.parseInt(options.timeoutMs, 10) || 120000),
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-pdf-ocr-'));
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
            fs.writeFileSync(imagePath, page.data);
            imagePaths.push(imagePath);
            const text = await ocrImageFile(imagePath, safe);
            if (text) texts.push(text);
        }
        return texts.join('\n\n').trim();
    } finally {
        for (const imagePath of imagePaths) {
            try { fs.rmSync(imagePath, { force: true }); } catch (_err) { /* ignore */ }
        }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_err) { /* ignore */ }
    }
}

async function extractDocumentTextWithOcrFallback(filePath, mimeType = '', originalName = '', options = {}) {
    const name = originalName || filePath || '';
    const ext = path.extname(String(name)).toLowerCase();
    if (isImageDocument(name)) {
        return ocrImageFile(filePath, options);
    }

    const text = await extractDocumentText(filePath, mimeType, name, options);
    if (String(text || '').trim() || options.ocrFallback === false) return text || '';
    if (ext === '.pdf' || String(mimeType || '').toLowerCase() === 'application/pdf') {
        return ocrPdfFile(filePath, options);
    }
    return text || '';
}

module.exports = {
    IMAGE_EXTENSIONS,
    extractDocumentTextWithOcrFallback,
    isImageDocument,
    ocrImageFile,
    ocrPdfFile,
    truncateExtractedText
};