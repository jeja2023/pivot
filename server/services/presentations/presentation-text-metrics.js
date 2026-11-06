'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const fontkit = require('@pdf-lib/fontkit');

let fallbackPromise;
async function fallbackFont() {
    fallbackPromise ||= fs.readFile(path.resolve(__dirname, '../../../assets/fonts/cjk/NotoSansSC-VF.ttf')).then(buffer => fontkit.create(buffer)).catch(() => null);
    return fallbackPromise;
}

function wrapByWidth(text, width, measure) {
    const lines = [];
    for (const paragraph of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
        let line = '';
        const tokens = paragraph.match(/\d+(?:[.,]\d+)*(?:万元|亿元|元|万|亿|%|年|月|日|人|项|个)?|[a-zA-Z]+|./gu) || [];
        for (const token of tokens) {
            const pieces = measure(token) > width ? Array.from(token) : [token];
            for (const piece of pieces) {
                if (line && measure(line + piece) > width) { lines.push(line); line = ''; }
                line += piece;
            }
        }
        lines.push(line);
    }
    return lines;
}

async function createTextMetrics(presentation = {}, { assetResolver } = {}) {
    const fallback = await fallbackFont();
    const fonts = new Map();
    for (const role of ['heading', 'body']) {
        const family = presentation.theme?.fonts?.[role];
        let font = fallback;
        const ref = presentation.theme?.fontAssets?.[role];
        if (ref && assetResolver) {
            try { const asset = await assetResolver(ref); if (asset?.buffer) font = fontkit.create(asset.buffer); } catch (_) { /* 缺失字体沿用受控中文回退，质量检查仍保留字体风险。 */ }
        }
        if (family) fonts.set(family, font);
    }
    function measure(text, size, family) {
        const font = fonts.get(family) || fallback;
        if (!font) return Array.from(text).reduce((width, character) => width + (character.charCodeAt(0) <= 255 ? 0.58 : 1) * size, 0);
        return font.layout(String(text)).positions.reduce((width, position) => width + position.xAdvance, 0) * size / font.unitsPerEm;
    }
    function lines(element) {
        const size = Number(element.style?.fontSize || 24);
        return wrapByWidth(element.content?.text || '', Math.max(1, element.width - Number(element.style?.padding || 0) * 2), text => measure(text, size, element.style?.fontFamily));
    }
    return { measured: Boolean(fallback), measure, lines };
}

async function fitDesignPresentation(content, options = {}) {
    if (!content.slides?.some(slide => String(slide.layoutId).startsWith('design-'))) return content;
    const metrics = await createTextMetrics(content, options);
    const next = JSON.parse(JSON.stringify(content));
    for (const slide of next.slides.filter(slide => String(slide.layoutId).startsWith('design-'))) {
        for (const element of slide.elements.filter(element => element.type === 'text' && !element.locked)) {
            const minimum = element.id === 'title' ? 36 : 24;
            while (element.style.fontSize > minimum && metrics.lines(element).length * element.style.fontSize * element.style.lineHeight + element.style.padding * 2 > element.height) element.style.fontSize--;
        }
    }
    return next;
}

module.exports = { createTextMetrics, fitDesignPresentation, wrapByWidth };
