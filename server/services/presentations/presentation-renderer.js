'use strict';

/** 受控 PPT IR 渲染器：PPTX、PDF 与 PNG 均从同一份已校验 IR 生成。 */
const fs = require('fs/promises');
const path = require('path');
const PptxGenJS = require('pptxgenjs');
const JSZip = require('jszip');
const { PDFDocument, rgb, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const sharp = require('sharp');
const graphics = require('../../../client/chat/presentation-graphics');
const geometry = require('./presentation-geometry');
const { normalizePresentation } = require('./presentation-schema');

const PRESENTATION_RENDERER_VERSION = 'ppt-studio-2.0.0';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const PDF_MIME = 'application/pdf';
const PNG_MIME = 'image/png';
const FONT_PATH = path.resolve(__dirname, '../../../assets/fonts/cjk/NotoSansSC-VF.ttf');
let cjkFontPromise = null;

function hexToRgb(color) {
    const normalized = String(color || '#000000').replace('#', '');
    return {
        r: Number.parseInt(normalized.slice(0, 2), 16) / 255,
        g: Number.parseInt(normalized.slice(2, 4), 16) / 255,
        b: Number.parseInt(normalized.slice(4, 6), 16) / 255
    };
}

function pptColor(color) {
    return String(color || '#000000').replace('#', '');
}

function escapeXml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function wrapText(text, maxChars) {
    const lines = [];
    String(text ?? '').split('\n').forEach(sourceLine => {
        let line = '';
        let currentUnits = 0;
        for (const char of sourceLine) {
            const charUnits = char.charCodeAt(0) <= 255 ? 1 : 1.75;
            if (currentUnits + charUnits > maxChars && line.length > 0) {
                lines.push(line);
                line = '';
                currentUnits = 0;
            }
            line += char;
            currentUnits += charUnits;
        }
        lines.push(line || ' ');
    });
    return lines;
}

function elementFontSizePx(element) {
    return Number(element.style?.fontSize || 18);
}

const createChartSvg = graphics.chartSvg;

function rawDataUri(asset) {
    if (!asset?.buffer || !asset?.mimeType) return '';
    return 'data:' + asset.mimeType + ';base64,' + Buffer.from(asset.buffer).toString('base64');
}

function mediaExtension(mimeType, fallback = 'mp4') {
    const type = String(mimeType || '').toLowerCase();
    if (type.includes('mpeg')) return 'mp3';
    if (type.includes('wav')) return 'wav';
    if (type.includes('ogg')) return 'ogg';
    if (type.includes('webm')) return 'webm';
    if (type.includes('quicktime')) return 'mov';
    return fallback;
}

const diagramSvg = graphics.diagramSvg;

function transitionXml(transition) {
    if (!transition || transition.type === 'none') return '';
    const speed = transition.durationMs <= 400 ? 'fast' : transition.durationMs >= 1200 ? 'slow' : 'med';
    const directionMap = { left: 'l', right: 'r', up: 'u', down: 'd', in: 'in', out: 'out' };
    const direction = directionMap[String(transition.direction || '').toLowerCase()] || '';
    const type = transition.type;
    const inner = type === 'fade' ? '<p:fade/>' : type === 'split' ? '<p:split' + (direction ? ' dir="' + direction + '"' : '') + '/>' : '<p:' + type + (direction ? ' dir="' + direction + '"' : '') + '/>';
    return '<p:transition spd="' + speed + '" advClick="1">' + inner + '</p:transition>';
}

function exportedAnimationName(element) {
    return 'pivotAnim_' + String(element?.id || '').replace(/[^A-Za-z0-9_-]/g, '_');
}

function animationFilter(type) {
    return ({ fade: 'fade', zoom: 'zoom', wipe: 'wipe', fly: 'fly' })[String(type || '')] || '';
}

function animationPresetId(type) {
    return ({ fade: 10, zoom: 24, wipe: 23, fly: 12 })[String(type || '')] || 0;
}

function animationTimingXml(animations) {
    if (!animations.length) return '';
    let nextId = 3;
    const items = animations.map((animation, index) => {
        const outerId = nextId++; const innerId = nextId++; const effectId = nextId++; const setId = nextId++; const behaviorId = nextId++;
        const delay = Math.max(0, Math.min(10000, Number(animation.delayMs) || 0));
        const duration = Math.max(100, Math.min(10000, Number(animation.durationMs) || 500));
        const filter = animationFilter(animation.type);
        const presetId = animationPresetId(animation.type);
        return '<p:par><p:cTn id="' + outerId + '" fill="hold"><p:stCondLst><p:cond delay="' + (index === 0 ? 'indefinite' : '0') + '"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="' + innerId + '" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="' + effectId + '" presetID="' + presetId + '" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="clickEffect"><p:stCondLst><p:cond delay="' + delay + '"/></p:stCondLst><p:childTnLst><p:set><p:cBhvr><p:cTn id="' + setId + '" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="' + animation.shapeId + '"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set><p:animEffect transition="in" filter="' + filter + '"><p:cBhvr><p:cTn id="' + behaviorId + '" dur="' + duration + '"/><p:tgtEl><p:spTgt spid="' + animation.shapeId + '"/></p:tgtEl></p:cBhvr></p:animEffect></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>';
    }).join('');
    const builds = animations.map(animation => '<p:bldP spid="' + animation.shapeId + '" grpId="0"/>').join('');
    return '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>' + items + '</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst><p:bldLst>' + builds + '</p:bldLst></p:timing>';
}

function exportedAnimationTargets(xml, slide) {
    const idsByName = new Map();
    const matcher = /<p:cNvPr\s+id="(\d+)"\s+name="(pivotAnim_[A-Za-z0-9_-]+)"/g;
    let match;
    while ((match = matcher.exec(xml))) idsByName.set(match[2], match[1]);
    return (slide.elements || []).filter(element => element.visible && element.animation?.type && element.animation.type !== 'none')
        .map(element => ({ ...element.animation, shapeId: idsByName.get(exportedAnimationName(element)) }))
        .filter(animation => animation.shapeId && animationFilter(animation.type));
}

async function applyPptxMotion(buffer, presentation) {
    const needsMotion = presentation.slides.some(slide => (slide.transition?.type && slide.transition.type !== 'none') || (slide.elements || []).some(element => element.visible && element.animation?.type && element.animation.type !== 'none'));
    if (!needsMotion) return buffer;
    const zip = await JSZip.loadAsync(buffer);
    for (let index = 0; index < presentation.slides.length; index += 1) {
        const name = 'ppt/slides/slide' + (index + 1) + '.xml'; const file = zip.file(name); if (!file) continue;
        const xml = await file.async('string'); const slide = presentation.slides[index];
        const transition = transitionXml(slide.transition);
        const timing = animationTimingXml(exportedAnimationTargets(xml, slide));
        if (!transition && !timing) continue;
        const clean = xml.replace(/<p:transition\b[\s\S]*?<\/p:transition>|<p:transition\b[^>]*\/>/g, '').replace(/<p:timing\b[\s\S]*?<\/p:timing>/g, '');
        zip.file(name, clean.replace('</p:sld>', transition + timing + '</p:sld>'));
    }
    return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

async function resolveDataUri(ref, assetResolver) {
    if (!ref || typeof assetResolver !== 'function') return '';
    const asset = await assetResolver(ref);
    if (!asset?.buffer || !asset?.mimeType) return '';
    // WebP/GIF 等对 pdf-lib 与 Office 的支持不一致；统一为 PNG，确保 PDF、
    // PNG 预览与 PPTX 的视觉结果一致。sharp 仅读取内存 Buffer，不接受外部路径。
    if (!/^image\/(?:png|jpe?g)$/i.test(asset.mimeType)) {
        const converted = await sharp(asset.buffer, { animated: false, limitInputPixels: 48_000_000 }).png().toBuffer();
        return `data:image/png;base64,${converted.toString('base64')}`;
    }
    return `data:${asset.mimeType};base64,${Buffer.from(asset.buffer).toString('base64')}`;
}

async function slideSvg(slide, presentation, options = {}) {
    const metrics = await require('./presentation-text-metrics').createTextMetrics(presentation, options);
    const pieces = [`<rect x="0" y="0" width="${presentation.width}" height="${presentation.height}" fill="${slide.background.fill}"/>`];
    const backgroundData = await resolveDataUri(slide.background.imageAssetRef, options.assetResolver);
    if (backgroundData) pieces.push(`<image href="${backgroundData}" x="0" y="0" width="${presentation.width}" height="${presentation.height}" opacity="${slide.background.opacity}" preserveAspectRatio="xMidYMid slice"/>`);
    for (const element of slide.elements.filter(item => item.visible)) {
        if (element.type === 'shape') {
            const svg = geometry.shapeSvg(element).replace(/^<svg[^>]*>|<\/svg>$/g, '');
            pieces.push(`<g transform="translate(${element.x} ${element.y}) rotate(${element.rotation} ${element.width / 2} ${element.height / 2})">${svg}</g>`);
            continue;
        }
        if (element.type === 'image') {
            const data = await resolveDataUri(element.assetRef, options.assetResolver);
            if (data) pieces.push(`<image href="${data}" x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" opacity="${element.opacity}" preserveAspectRatio="xMidYMid ${element.fit === 'contain' ? 'meet' : element.fit === 'stretch' ? 'none' : 'slice'}"/>`);
            continue;
        }
const SVG_VECTOR_ICONS = {
    '💡': { color: '#D8A23A', svg: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z" fill="none" stroke="currentColor" stroke-width="2"/>' },
    '🎯': { color: '#C84A4A', svg: '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2" fill="currentColor"/>' },
    '✦': { color: '#1F5EA8', svg: '<path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8L12 2z" fill="currentColor"/>' },
    '★': { color: '#D8A23A', svg: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="currentColor"/>' },
    '☑': { color: '#2E8B57', svg: '<rect x="3" y="3" width="18" height="18" rx="4" fill="#E8F5E9" stroke="#2E8B57" stroke-width="2"/><path d="M9 12l2 2 4-4" fill="none" stroke="#2E8B57" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' },
    '□': { color: '#94A3B8', svg: '<rect x="3" y="3" width="18" height="18" rx="4" fill="#FFFFFF" stroke="#94A3B8" stroke-width="2"/>' },
    '🚀': { color: '#1F5EA8', svg: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" fill="none" stroke="currentColor" stroke-width="2"/>' },
    '📌': { color: '#17A8C7', svg: '<line x1="12" y1="17" x2="12" y2="22" stroke="currentColor" stroke-width="2"/><path d="M5 17h14v-2l-2-2V5a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v8l-2 2v2z" fill="none" stroke="currentColor" stroke-width="2"/>' },
    '⚠️': { color: '#D8A23A', svg: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" fill="none" stroke="currentColor" stroke-width="2"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="2"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" stroke-width="2"/>' },
    '🛡️': { color: '#7A5AF8', svg: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="none" stroke="currentColor" stroke-width="2"/>' }
};

        if (element.type === 'media') {
            const poster = await resolveDataUri(element.posterAssetRef, options.assetResolver);
            if (poster) pieces.push('<image href="' + poster + '" x="' + element.x + '" y="' + element.y + '" width="' + element.width + '" height="' + element.height + '" preserveAspectRatio="xMidYMid meet"/>');
            pieces.push('<rect x="' + element.x + '" y="' + element.y + '" width="' + element.width + '" height="' + element.height + '" rx="10" fill="' + (poster ? '#000000' : '#0F172A') + '" fill-opacity="' + (poster ? '0.22' : '1') + '" stroke="#64748B"/>');
            const centerX = element.x + element.width / 2;
            const centerY = element.y + element.height / 2;
            if (element.mediaType === 'audio') {
                pieces.push(`<g transform="translate(${centerX - 50}, ${centerY - 12})"><polygon points="11,5 6,9 2,9 2,15 6,15 11,19 11,5" fill="#FFFFFF"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/></g>`);
                pieces.push(`<text x="${centerX + 8}" y="${centerY + 7}" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="20" font-weight="600" fill="#FFFFFF">音频媒体</text>`);
            } else {
                pieces.push(`<g transform="translate(${centerX - 50}, ${centerY - 12})"><polygon points="5,3 19,12 5,21" fill="#FFFFFF"/></g>`);
                pieces.push(`<text x="${centerX + 8}" y="${centerY + 7}" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="20" font-weight="600" fill="#FFFFFF">视频媒体</text>`);
            }
            continue;
        }
        if (element.type === 'attachment') {
            pieces.push('<rect x="' + element.x + '" y="' + element.y + '" width="' + element.width + '" height="' + element.height + '" rx="8" fill="#F8FAFC" stroke="#64748B"/>');
            pieces.push(`<g transform="translate(${element.x + 14}, ${element.y + 11})"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" fill="none" stroke="#1E293B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>`);
            pieces.push('<text x="' + (element.x + 40) + '" y="' + (element.y + 28) + '" font-family="Microsoft YaHei, sans-serif" font-size="16" fill="#1E293B">' + escapeXml(element.filename) + '</text>');
            continue;
        }
        if (element.type === 'diagram') {
            const diagram = diagramSvg(element);
            pieces.push('<g transform="translate(' + element.x + ' ' + element.y + ')">' + diagram.replace(/^<svg[^>]*>|<\/svg>$/g, '') + '</g>');
            continue;
        }
        if (element.type === 'chart') {
            const chart = createChartSvg(element, element.width, element.height);
            pieces.push(`<g transform="translate(${element.x} ${element.y})">${chart.replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g>`);
            continue;
        }
        if (element.type === 'table') {
            const rows = [element.columns, ...element.rows];
            const rowHeight = element.height / Math.max(1, rows.length);
            const columnWidth = element.width / Math.max(1, element.columns.length);
            rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
                const x = element.x + columnIndex * columnWidth;
                const y = element.y + rowIndex * rowHeight;
                const header = rowIndex === 0;
                pieces.push(`<rect x="${x}" y="${y}" width="${columnWidth}" height="${rowHeight}" fill="${header ? element.style.headerFill : element.style.cellFill}" stroke="${element.style.borderColor}"/>`);
                const lines = wrapText(cell, Math.max(3, Math.floor(columnWidth / Math.max(1, element.style.fontSize * 0.58))));
                lines.slice(0, Math.max(1, Math.floor(rowHeight / (element.style.fontSize * 1.25)))).forEach((line, lineIndex) => {
                    pieces.push(`<text x="${x + 8}" y="${y + element.style.fontSize + 5 + lineIndex * element.style.fontSize * 1.25}" font-family="Microsoft YaHei, Noto Sans SC, sans-serif" font-size="${element.style.fontSize}" fill="${header ? element.style.headerColor : element.style.cellColor}">${escapeXml(line)}</text>`);
                });
            }));
            continue;
        }
        const lines = metrics.lines(element);
        const align = element.style.align === 'center' ? 'middle' : element.style.align === 'right' ? 'end' : 'start';
        const textX = element.style.align === 'center' ? element.x + element.width / 2 : element.style.align === 'right' ? element.x + element.width - element.style.padding : element.x + element.style.padding;
        const startY = element.y + element.style.padding + element.style.fontSize;
        const weight = element.style.fontWeight >= 600 ? '700' : '400';
        const hasIcons = lines.some(l => Object.keys(SVG_VECTOR_ICONS).some(k => l.includes(k)));
        if (!hasIcons) {
            pieces.push(`<text x="${textX}" y="${startY}" text-anchor="${align}" font-family="${escapeXml(element.style.fontFamily)}, Microsoft YaHei, Noto Sans SC, sans-serif" font-size="${element.style.fontSize}" font-weight="${weight}" fill="${element.style.color}" transform="rotate(${element.rotation} ${element.x + element.width / 2} ${element.y + element.height / 2})">${lines.map((line, index) => `<tspan x="${textX}" dy="${index ? element.style.fontSize * element.style.lineHeight : 0}">${escapeXml(line || ' ')}</tspan>`).join('')}</text>`);
        } else {
            lines.forEach((line, index) => {
                const lineY = startY + index * element.style.fontSize * element.style.lineHeight;
                let foundKey = null;
                for (const k of Object.keys(SVG_VECTOR_ICONS)) {
                    if (line.trim().startsWith(k)) { foundKey = k; break; }
                }
                if (foundKey) {
                    const iconDef = SVG_VECTOR_ICONS[foundKey];
                    const cleanText = line.replace(foundKey, '').trim();
                    const scale = (element.style.fontSize * 0.95) / 24;
                    const iconY = lineY - element.style.fontSize * 0.82;
                    pieces.push(`<g transform="translate(${textX}, ${iconY}) scale(${scale.toFixed(3)})" color="${iconDef.color}">${iconDef.svg}</g>`);
                    pieces.push(`<text x="${textX + element.style.fontSize * 1.35}" y="${lineY}" text-anchor="${align}" font-family="${escapeXml(element.style.fontFamily)}, Microsoft YaHei, Noto Sans SC, sans-serif" font-size="${element.style.fontSize}" font-weight="${weight}" fill="${element.style.color}">${escapeXml(cleanText)}</text>`);
                } else {
                    pieces.push(`<text x="${textX}" y="${lineY}" text-anchor="${align}" font-family="${escapeXml(element.style.fontFamily)}, Microsoft YaHei, Noto Sans SC, sans-serif" font-size="${element.style.fontSize}" font-weight="${weight}" fill="${element.style.color}">${escapeXml(line)}</text>`);
                }
            });
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${presentation.width}" height="${presentation.height}" viewBox="0 0 ${presentation.width} ${presentation.height}">${pieces.join('')}</svg>`;
}

async function renderPng(presentation, options = {}) {
    const slideIndex = Math.max(0, Math.min(Number.parseInt(options.slideIndex, 10) || 0, presentation.slides.length - 1));
    const svg = await slideSvg(presentation.slides[slideIndex], presentation, options);
    const pipeline = sharp(Buffer.from(svg));
    return options.imageQuality === 'high' ? pipeline.png({ compressionLevel: 6 }) .toBuffer() : pipeline.png({ compressionLevel: 9 }).toBuffer();
}

async function loadCjkFont(pdf) {
    pdf.registerFontkit(fontkit);
    if (!cjkFontPromise) cjkFontPromise = fs.readFile(FONT_PATH).catch(() => null);
    const buffer = await cjkFontPromise;
    return buffer ? await pdf.embedFont(buffer, { subset: true }) : null;
}

async function loadPresentationPdfFonts(pdf, presentation, options = {}) {
    const fallback = await loadCjkFont(pdf) || await pdf.embedFont('Helvetica');
    const load = async ref => {
        if (!ref || typeof options.assetResolver !== 'function') return null;
        try { const asset = await options.assetResolver(ref); return asset?.buffer ? await pdf.embedFont(asset.buffer, { subset: true }) : null; } catch (_) { return null; }
    };
    const heading = await load(presentation.theme.fontAssets?.heading) || fallback;
    const body = await load(presentation.theme.fontAssets?.body) || heading || fallback;
    return { fallback, heading, body };
}

function pdfFontForElement(fonts, presentation, element) {
    return element?.style?.fontFamily === presentation.theme.fonts.heading ? fonts.heading : element?.style?.fontFamily === presentation.theme.fonts.body ? fonts.body : fonts.fallback;
}

function drawPdfText(page, font, text, element, pdfHeight) {
    const size = Math.max(6, elementFontSizePx(element) * 0.75);
    const maxWidth = Math.max(1, element.width * 0.75 - element.style.padding * 1.5);
    const lines = require('./presentation-text-metrics').wrapByWidth(text, maxWidth, value => font.widthOfTextAtSize(value, size));
    const color = hexToRgb(element.style.color);
    lines.forEach((line, index) => {
        const y = pdfHeight - (element.y * 0.75 + element.style.padding + size + index * size * element.style.lineHeight);
        let x = element.x * 0.75 + element.style.padding;
        const lineWidth = font.widthOfTextAtSize(line, size);
        if (element.style.align === 'center') x += Math.max(0, (maxWidth - lineWidth) / 2);
        if (element.style.align === 'right') x += Math.max(0, maxWidth - lineWidth);
        page.drawText(line, { x, y, size, font, color: rgb(color.r, color.g, color.b), rotate: element.rotation ? degrees(-element.rotation) : undefined });
    });
}

async function renderPdf(presentation, options = {}) {
    const pdf = await PDFDocument.create();
    const fonts = await loadPresentationPdfFonts(pdf, presentation, options);
    const width = presentation.width * 0.75;
    const height = presentation.height * 0.75;
    for (const slide of presentation.slides) {
        const page = pdf.addPage([width, height]);
        const bg = hexToRgb(slide.background.fill);
        page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(bg.r, bg.g, bg.b) });
        if (slide.background.imageAssetRef) {
            const asset = await options.assetResolver?.(slide.background.imageAssetRef);
            if (asset?.buffer) {
                try {
                    const buffer = /^image\/(?:png|jpe?g)$/i.test(asset.mimeType)
                        ? asset.buffer
                        : await sharp(asset.buffer, { animated: false, limitInputPixels: 48_000_000 }).png().toBuffer();
                    const image = /^image\/png/i.test(asset.mimeType) || !/^image\/(?:png|jpe?g)$/i.test(asset.mimeType)
                        ? await pdf.embedPng(buffer)
                        : await pdf.embedJpg(buffer);
                    page.drawImage(image, { x: 0, y: 0, width, height, opacity: slide.background.opacity });
                } catch (_) { /* 背景图损坏或不可解码时保留主题色，不终止整份导出 */ }
            }
        }
        for (const element of slide.elements.filter(item => item.visible)) {
            const y = height - (element.y + element.height) * 0.75;
            if (element.type === 'shape') {
                const scene = geometry.shapeScene(element.shapeType, element.width, element.height, geometry.effectiveAdjustments(element));
                const angle = element.rotation * Math.PI / 180, cx = element.width / 2, cy = element.height / 2;
                const left = element.x + cx - Math.cos(angle) * cx + Math.sin(angle) * cy;
                const top = element.y + cy - Math.sin(angle) * cx - Math.cos(angle) * cy;
                for (const path of scene.paths) {
                    const fill = path.fill === 'none' ? null : hexToRgb(geometry.shade(element.style.fill, path.fill));
                    const stroke = path.stroke && element.style.strokeWidth ? hexToRgb(element.style.stroke) : null;
                    if (!fill && !stroke) continue;
                    page.drawSvgPath(path.d, { x: left * 0.75, y: height - top * 0.75, scale: 0.75, rotate: degrees(-element.rotation),
                        color: fill ? rgb(fill.r, fill.g, fill.b) : undefined, opacity: element.style.opacity,
                        borderColor: stroke ? rgb(stroke.r, stroke.g, stroke.b) : undefined, borderWidth: stroke ? element.style.strokeWidth : 0 });
                }
                continue;
            }
            if (element.type === 'text') {
                drawPdfText(page, pdfFontForElement(fonts, presentation, element), element.content.text, element, height);
                continue;
            }
            if (element.type === 'table') {
                const rows = [element.columns, ...element.rows];
                const rowHeight = element.height / rows.length;
                const colWidth = element.width / element.columns.length;
                rows.forEach((row, rowIndex) => row.forEach((cell, colIndex) => {
                    const header = rowIndex === 0;
                    const fill = hexToRgb(header ? element.style.headerFill : element.style.cellFill);
                    const stroke = hexToRgb(element.style.borderColor);
                    page.drawRectangle({ x: (element.x + colIndex * colWidth) * 0.75, y: height - (element.y + (rowIndex + 1) * rowHeight) * 0.75, width: colWidth * 0.75, height: rowHeight * 0.75, color: rgb(fill.r, fill.g, fill.b), borderColor: rgb(stroke.r, stroke.g, stroke.b), borderWidth: 0.5 });
                    drawPdfText(page, fonts.body || fonts.fallback, String(cell), { ...element, x: element.x + colIndex * colWidth, y: element.y + rowIndex * rowHeight, width: colWidth, height: rowHeight, style: { ...element.style, color: header ? element.style.headerColor : element.style.cellColor } }, height);
                }));
                continue;
            }
            if (element.type === 'media' || element.type === 'attachment') {
                const posterRef = element.type === 'media' ? element.posterAssetRef : '';
                const asset = posterRef ? await options.assetResolver?.(posterRef) : null;
                let poster = null;
                if (asset?.buffer) { try { const data = /^image\/(?:png|jpe?g)$/i.test(asset.mimeType) ? asset.buffer : await sharp(asset.buffer).png().toBuffer(); poster = /^image\/png/i.test(asset.mimeType) ? await pdf.embedPng(data) : await pdf.embedJpg(data); } catch (_) {} }
                page.drawRectangle({ x: element.x * 0.75, y, width: element.width * 0.75, height: element.height * 0.75, color: rgb(0.06, 0.09, 0.16), borderColor: rgb(0.4, 0.45, 0.52), borderWidth: 1 });
                if (poster) page.drawImage(poster, { x: element.x * 0.75, y, width: element.width * 0.75, height: element.height * 0.75, opacity: 0.8 });
                const label = element.type === 'attachment' ? '附件：' + element.filename : (element.mediaType === 'audio' ? '音频媒体' : '视频媒体');
                page.drawText(label, { x: element.x * 0.75 + 10, y: y + element.height * 0.375, size: 12, font: fonts.body || fonts.fallback, color: rgb(1, 1, 1) });
                continue;
            }
            if (element.type === 'diagram') {
                const diagramPng = await sharp(Buffer.from(diagramSvg(element))).png().toBuffer();
                const image = await pdf.embedPng(diagramPng); page.drawImage(image, { x: element.x * 0.75, y, width: element.width * 0.75, height: element.height * 0.75 });
                continue;
            }
            if (element.type === 'chart') {
                const chartPng = await sharp(Buffer.from(createChartSvg(element, Math.round(element.width), Math.round(element.height)))).png().toBuffer();
                const image = await pdf.embedPng(chartPng);
                page.drawImage(image, { x: element.x * 0.75, y, width: element.width * 0.75, height: element.height * 0.75 });
                continue;
            }
            if (element.type === 'image') {
                const asset = await options.assetResolver?.(element.assetRef);
                if (!asset?.buffer) continue;
                try {
                    const buffer = /^image\/(?:png|jpe?g)$/i.test(asset.mimeType)
                        ? asset.buffer
                        : await sharp(asset.buffer, { animated: false, limitInputPixels: 48_000_000 }).png().toBuffer();
                    const image = /^image\/png/i.test(asset.mimeType) || !/^image\/(?:png|jpe?g)$/i.test(asset.mimeType)
                        ? await pdf.embedPng(buffer)
                        : await pdf.embedJpg(buffer);
                    page.drawImage(image, { x: element.x * 0.75, y, width: element.width * 0.75, height: element.height * 0.75, opacity: element.opacity });
                } catch (_) { /* unsupported image cannot compromise the whole export */ }
            }
        }
    }
    return await pdf.save();
}

function pointOptions(element, presentation) {
    const widthIn = presentation.aspectRatio === '4:3' ? 10 : 40 / 3;
    const heightIn = 7.5;
    return { x: element.x / presentation.width * widthIn, y: element.y / presentation.height * heightIn, w: element.width / presentation.width * widthIn, h: element.height / presentation.height * heightIn };
}

async function renderPptx(presentation, options = {}) {
    const metrics = await require('./presentation-text-metrics').createTextMetrics(presentation, options);
    const pptx = new PptxGenJS();
    pptx.layout = presentation.aspectRatio === '4:3' ? 'LAYOUT_4x3' : 'LAYOUT_WIDE';
    pptx.author = 'Pivot';
    pptx.company = 'Pivot';
    pptx.subject = presentation.title;
    pptx.title = presentation.title;
    pptx.lang = presentation.metadata.language || 'zh-CN';
    pptx.theme = {
        headFontFace: presentation.theme.fonts.heading,
        bodyFontFace: presentation.theme.fonts.body,
        lang: presentation.metadata.language || 'zh-CN'
    };
    for (const slideData of presentation.slides) {
        const slide = pptx.addSlide();
        slide.background = { color: pptColor(slideData.background.fill) };
        if (slideData.background.imageAssetRef) {
            const data = await resolveDataUri(slideData.background.imageAssetRef, options.assetResolver);
            if (data) slide.addImage({ data, x: 0, y: 0, w: presentation.aspectRatio === '4:3' ? 10 : 13.333, h: 7.5, transparency: Math.round((1 - slideData.background.opacity) * 100) });
        }
        for (const element of slideData.elements.filter(item => item.visible)) {
            const pos = pointOptions(element, presentation);
            if (element.type === 'text') {
                const controlledText = presentation.template.version >= 2 && slideData.layoutId.startsWith('design-');
                slide.addText(controlledText ? metrics.lines(element).join('\n') : element.content.text, {
                    ...pos, margin: element.style.padding / 72, fontFace: element.style.fontFamily, fontSize: element.style.fontSize * 0.75,
                    bold: element.style.fontWeight >= 600, italic: element.style.italic, underline: element.style.underline,
                    color: pptColor(element.style.color), align: element.style.align, valign: element.style.verticalAlign,
                    breakLine: false, fit: controlledText ? 'none' : 'shrink', wrap: !controlledText,
                    ...(controlledText ? { lineSpacingMultiple: element.style.lineHeight } : {}), rotate: element.rotation, paraSpaceAfterPt: 0,
                    bullet: element.style.bullet ? { type: 'ul' } : undefined, objectName: exportedAnimationName(element)
                });
                continue;
            }
            if (element.type === 'shape') {
                const shape = pptx.ShapeType[element.shapeType] || pptx.ShapeType.rect;
                slide.addShape(shape, {
                    ...pos, rotate: element.rotation, fill: { color: pptColor(element.style.fill), transparency: Math.round((1 - element.style.opacity) * 100) },
                    line: { color: pptColor(element.style.stroke), width: element.style.strokeWidth }, objectName: exportedAnimationName(element)
                });
                continue;
            }
            if (element.type === 'table') {
                const rows = [element.columns, ...element.rows].map((row, index) => row.map(value => ({ text: String(value), options: {
                    fill: index === 0 ? pptColor(element.style.headerFill) : pptColor(element.style.cellFill),
                    color: index === 0 ? pptColor(element.style.headerColor) : pptColor(element.style.cellColor), bold: index === 0
                } })));
                slide.addTable(rows, {
                    ...pos, border: { type: 'solid', color: pptColor(element.style.borderColor), pt: 0.5 },
                    fontFace: presentation.theme.fonts.body, fontSize: element.style.fontSize * 0.75,
                    color: pptColor(element.style.cellColor), fill: pptColor(element.style.cellFill),
                    bold: false, margin: 0.05,
                    rowH: pos.h / Math.max(1, element.rows.length + 1),
                    autoFit: false, autoPage: false, objectName: exportedAnimationName(element)
                });
                continue;
            }
            if (element.type === 'image') {
                const asset = await options.assetResolver?.(element.assetRef);
                if (!asset?.buffer || !asset?.mimeType) throw new Error('图片素材不可读取，请重新上传或恢复素材后导出。');
                const data = await resolveDataUri(element.assetRef, async () => asset);
                slide.addImage({ data, ...pos, transparency: Math.round((1 - element.opacity) * 100), objectName: exportedAnimationName(element) });
                continue;
            }
            if (element.type === 'media') {
                const asset = await options.assetResolver?.(element.assetRef);
                if (!asset?.buffer || !asset?.mimeType) throw new Error('音视频素材不可读取，请重新上传或恢复素材后导出。');
                slide.addMedia({ type: element.mediaType, data: rawDataUri(asset), ext: mediaExtension(asset.mimeType, element.mediaType === 'audio' ? 'mp3' : 'mp4'), ...pos, objectName: exportedAnimationName(element) });
                continue;
            }
            if (element.type === 'attachment') {
                slide.addShape(pptx.ShapeType.roundRect, { ...pos, rectRadius: 0.08, fill: { color: 'F8FAFC' }, line: { color: '64748B', width: 1 } });
                slide.addText('附件：' + element.filename, { ...pos, margin: 0.08, color: '1E293B', fontSize: 11, valign: 'mid' });
                continue;
            }
            if (element.type === 'diagram') {
                require('./presentation-native-diagram').addNativeDiagram(slide, pptx, element, pos, presentation.theme.fonts.body);
                continue;
            }
            if (element.type === 'chart') {
                const categories = element.data.rows.map(row => String(row[0]));
                const series = element.data.columns.slice(1).map((name, seriesIndex) => ({ name, labels: categories, values: element.data.rows.map(row => Number(row[seriesIndex + 1]) || 0) }));
                const chartType = pptx.ChartType[element.chartType] || pptx.ChartType.bar;
                const labelSize = (element.options.labelFontSize || 14) * 0.75;
                slide.addChart(chartType, series, { ...pos, catAxisLabelFontFace: presentation.theme.fonts.body, valAxisLabelFontFace: presentation.theme.fonts.body,
                        catAxisLabelFontSize: labelSize, valAxisLabelFontSize: labelSize, dataLabelFontSize: labelSize, dataLabelColor: pptColor(presentation.theme.colors.text),
                        valGridLine: { color: 'D3DCD4', width: 0.5 }, showLegend: element.options.showLegend, showValue: element.options.showLabels, showTitle: Boolean(element.title), title: element.title || undefined, chartColors: (element.options.colors.length ? element.options.colors : graphics.PALETTE).map(pptColor), showCatName: false,
                        objectName: exportedAnimationName(element), barDir: 'col' });
            }
        }
        if (options.includeNotes !== false && slideData.speakerNotes) slide.addNotes(slideData.speakerNotes.split('\n'));
    }
    const raw = await pptx.write({ outputType: 'nodebuffer' });
    const native = await require('./presentation-native-package').applyNativePresentationObjects(Buffer.from(raw), presentation);
    return await applyPptxMotion(native, presentation);
}

async function renderPresentation(input, format, options = {}) {
    const presentation = normalizePresentation(input);
    const normalizedFormat = String(format || '').trim().toLowerCase();
    const startedAt = Date.now();
    let buffer;
    let mimeType;
    if (normalizedFormat === 'pptx') {
        buffer = await renderPptx(presentation, options);
        mimeType = PPTX_MIME;
    } else if (normalizedFormat === 'pdf') {
        buffer = await renderPdf(presentation, options);
        mimeType = PDF_MIME;
    } else if (normalizedFormat === 'svg') {
        const slideIndex = Number(options.slideIndex || 0);
        if (!Number.isInteger(slideIndex) || slideIndex < 0 || slideIndex >= presentation.slides.length) throw new Error('要导出的 PPT 页码不存在。');
        buffer = Buffer.from(await slideSvg(presentation.slides[slideIndex], presentation, options));
        mimeType = 'image/svg+xml';
    } else if (normalizedFormat === 'png') {
        buffer = await renderPng(presentation, options);
        mimeType = PNG_MIME;
    } else {
        const error = new Error('仅支持导出 PPTX、PDF、PNG 或单页 SVG。');
        error.status = 400;
        error.code = 'PRESENTATION_EXPORT_FORMAT_INVALID';
        throw error;
    }
    return { buffer: Buffer.from(buffer), format: normalizedFormat, mimeType, rendererVersion: PRESENTATION_RENDERER_VERSION, durationMs: Date.now() - startedAt };
}

module.exports = {
    PRESENTATION_RENDERER_VERSION,
    renderPresentation
};
