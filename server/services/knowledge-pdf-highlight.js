'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { renderPdfPages } = require('../document-text');

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
let active = 0;

function findUniqueTextBoxes(items, quote, viewport, transform) {
    const text = [], positions = [];
    items.forEach((item, index) => {
        for (const char of String(item.str || '')) {
            if (/\s/u.test(char)) continue;
            text.push(char); positions.push(index);
        }
    });
    const source = text.join('');
    const target = String(quote || '').replace(/\s/gu, '').slice(0, 100);
    if (target.length < 6) return [];
    const start = source.indexOf(target);
    if (start < 0 || source.indexOf(target, start + 1) >= 0) return [];
    const indexes = [...new Set(positions.slice(start, start + target.length))];
    const boxes = indexes.map(index => {
        const item = items[index], matrix = transform(viewport.transform, item.transform);
        const height = Math.hypot(matrix[2], matrix[3]);
        const width = Number(item.width) * viewport.scale;
        return { x: matrix[4], y: matrix[5] - height, width, height };
    }).filter(box => Object.values(box).every(Number.isFinite) && box.width > 0 && box.height > 0
        && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 2 && box.y + box.height <= viewport.height + 2);
    return boxes.length === indexes.length && boxes.length <= 100 ? boxes : [];
}

function findOcrTextBoxes(location, quote, width, height) {
    if (!location || !(location.width > 0 && location.height > 0) || Math.abs(width / height - location.width / location.height) > 0.01) return [];
    const blocks = Array.isArray(location.blocks) ? location.blocks : [];
    const text = [], positions = [];
    blocks.forEach((block, index) => {
        for (const char of String(block.text || '')) if (!/\s/u.test(char)) { text.push(char); positions.push(index); }
    });
    const target = String(quote || '').replace(/\s/gu, '').slice(0, 100), source = text.join('');
    if (target.length < 6) return [];
    const start = source.indexOf(target);
    if (start < 0 || source.indexOf(target, start + 1) >= 0) return [];
    const indexes = [...new Set(positions.slice(start, start + target.length))];
    const boxes = indexes.map(index => {
        const points = blocks[index].bbox;
        if (!Array.isArray(points) || points.length < 4 || !points.every(point => Array.isArray(point) && point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))) return null;
        const xs = points.map(point => Number(point[0])), ys = points.map(point => Number(point[1]));
        const x = Math.min(...xs), y = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys);
        if (x < 0 || y < 0 || right > location.width || bottom > location.height || right <= x || bottom <= y) return null;
        return { x: x * width / location.width, y: y * height / location.height, width: (right - x) * width / location.width, height: (bottom - y) * height / location.height };
    }).filter(Boolean);
    return boxes.length === indexes.length && boxes.length <= 100 ? boxes : [];
}

async function renderCitationHighlight({ filePath, page, quote, expectedHash, ocrLocation = null }) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !/^[a-f0-9]{64}$/i.test(String(expectedHash || ''))) throw new Error('引用定位或来源版本不可用。');
    if (active >= 2) throw Object.assign(new Error('来源预览繁忙，请稍后重试。'), { status: 429 });
    active++;
    let parser;
    try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error('来源文件过大，无法生成高亮预览。');
        const bytes = await fs.readFile(filePath);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedHash.toLowerCase()) throw new Error('来源文件已变化，请重新索引后查看。');
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        parser = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
        if (page > parser.numPages) throw new Error('来源页码不存在。');
        const pdfPage = await parser.getPage(page);
        const first = pdfPage.getViewport({ scale: 1 });
        if (!(first.width > 0 && first.height > 0) || first.height / first.width > 4) throw new Error('来源页面尺寸不适合生成高亮预览。');
        const screenshots = await renderPdfPages(filePath, { first: page, last: page, maxPages: 1, desiredWidth: 1600 });
        if (!screenshots[0]?.data) throw new Error('来源页面渲染失败。');
        if (crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex') !== expectedHash.toLowerCase()) throw new Error('来源文件已变化，请重新索引后查看。');
        const dimensions = await sharp(screenshots[0].data).metadata();
        const viewport = pdfPage.getViewport({ scale: dimensions.width / first.width });
        const content = await pdfPage.getTextContent();
        const nativeBoxes = findUniqueTextBoxes(content.items, quote, viewport, pdfjs.Util.transform);
        const boxes = nativeBoxes.length ? nativeBoxes : findOcrTextBoxes(ocrLocation, quote, dimensions.width, dimensions.height);
        if (!boxes.length) throw new Error('无法在原文中唯一定位该引用，可使用页码预览。');
        const rectangles = boxes.map(box => `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="#ffd500" fill-opacity="0.38"/>`).join('');
        const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}">${rectangles}</svg>`);
        return await sharp(screenshots[0].data).composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
    } finally {
        try { if (parser) await parser.destroy(); } finally { active--; }
    }
}

module.exports = { findUniqueTextBoxes, findOcrTextBoxes, renderCitationHighlight };
