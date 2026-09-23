'use strict';

/** 受控 PPT IR 渲染器：PPTX、PDF 与 PNG 均从同一份已校验 IR 生成。 */
const fs = require('fs/promises');
const path = require('path');
const PptxGenJS = require('pptxgenjs');
const JSZip = require('jszip');
const { PDFDocument, rgb, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const sharp = require('sharp');
const { normalizePresentation } = require('./presentation-schema');

const PRESENTATION_RENDERER_VERSION = 'presentation-1.165.0';
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
        for (const char of sourceLine) {
            line += char;
            if (line.length >= maxChars) {
                lines.push(line);
                line = '';
            }
        }
        lines.push(line || ' ');
    });
    return lines;
}

function elementFontSizePx(element) {
    return Number(element.style?.fontSize || 18);
}

function createChartSvg(element, width, height) {
    const rows = element.data?.rows || [];
    const values = rows.map(row => Number(row[1]) || 0);
    const maximum = Math.max(1, ...values.map(value => Math.abs(value)));
    const colors = element.options?.colors?.length ? element.options.colors : ['#1769AA', '#5B8FF9', '#61DDAA', '#F59E0B'];
    const pad = { top: element.title ? 34 : 12, right: 14, bottom: 38, left: 38 };
    const graphWidth = Math.max(1, width - pad.left - pad.right);
    const graphHeight = Math.max(1, height - pad.top - pad.bottom);
    let pieces = `<rect width="${width}" height="${height}" fill="#FFFFFF"/><line x1="${pad.left}" y1="${pad.top + graphHeight}" x2="${pad.left + graphWidth}" y2="${pad.top + graphHeight}" stroke="#CBD5E1"/><line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + graphHeight}" stroke="#CBD5E1"/>`;
    if (element.title) pieces += `<text x="${pad.left}" y="20" font-size="15" font-weight="700" fill="#1F2937">${escapeXml(element.title)}</text>`;
    if (element.chartType === 'pie') {
        const total = values.reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
        const radius = Math.min(graphWidth, graphHeight) * 0.36;
        const cx = pad.left + graphWidth / 2;
        const cy = pad.top + graphHeight / 2;
        let start = -Math.PI / 2;
        values.forEach((value, index) => {
            const angle = Math.max(0, value) / total * Math.PI * 2;
            const end = start + angle;
            const x1 = cx + radius * Math.cos(start);
            const y1 = cy + radius * Math.sin(start);
            const x2 = cx + radius * Math.cos(end);
            const y2 = cy + radius * Math.sin(end);
            const large = angle > Math.PI ? 1 : 0;
            pieces += `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z" fill="${colors[index % colors.length]}"/>`;
            start = end;
        });
    } else if (element.chartType === 'line' || element.chartType === 'area') {
        const points = values.map((value, index) => {
            const x = pad.left + (values.length <= 1 ? graphWidth / 2 : graphWidth * index / (values.length - 1));
            const y = pad.top + graphHeight - (value / maximum) * graphHeight;
            return [x, y];
        });
        if (points.length) {
            const line = points.map(point => point.join(',')).join(' ');
            if (element.chartType === 'area') {
                pieces += `<polygon points="${pad.left},${pad.top + graphHeight} ${line} ${pad.left + graphWidth},${pad.top + graphHeight}" fill="${colors[0]}" fill-opacity="0.22"/>`;
            }
            pieces += `<polyline points="${line}" fill="none" stroke="${colors[0]}" stroke-width="3"/>`;
            points.forEach(point => { pieces += `<circle cx="${point[0]}" cy="${point[1]}" r="3.5" fill="${colors[0]}"/>`; });
        }
    } else {
        const gap = Math.max(4, graphWidth / Math.max(1, values.length) * 0.2);
        const barWidth = Math.max(3, (graphWidth - gap * (values.length + 1)) / Math.max(1, values.length));
        values.forEach((value, index) => {
            const barHeight = Math.max(0, value / maximum * graphHeight);
            const x = pad.left + gap + index * (barWidth + gap);
            const y = pad.top + graphHeight - barHeight;
            pieces += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="3" fill="${colors[index % colors.length]}"/>`;
        });
    }
    rows.forEach((row, index) => {
        const x = pad.left + (rows.length <= 1 ? graphWidth / 2 : graphWidth * index / (rows.length - 1));
        pieces += `<text x="${x}" y="${height - 12}" text-anchor="middle" font-size="11" fill="#64748B">${escapeXml(String(row[0]))}</text>`;
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${pieces}</svg>`;
}

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

function diagramSvg(element) {
    const count = element.items.length; const horizontal = element.diagramType !== 'hierarchy';
    const gap = 18; const width = element.width; const height = element.height;
    const nodeWidth = horizontal ? Math.max(80, (width - gap * (count - 1)) / count) : Math.max(100, width * 0.45);
    const nodeHeight = horizontal ? Math.max(48, height * 0.55) : Math.max(38, (height - gap * (count - 1)) / count);
    const pieces = [];
    element.items.forEach((text, index) => {
        const x = horizontal ? index * (nodeWidth + gap) : (width - nodeWidth) / 2;
        const y = horizontal ? (height - nodeHeight) / 2 : index * (nodeHeight + gap);
        if (index > 0) { const px = horizontal ? x - gap : width / 2; const py = horizontal ? height / 2 : y - gap; const ax = horizontal ? x - 5 : width / 2; const ay = horizontal ? height / 2 : y - 5; pieces.push('<line x1="' + px + '" y1="' + py + '" x2="' + ax + '" y2="' + ay + '" stroke="' + element.style.stroke + '" stroke-width="2" marker-end="url(#arrow)"/>'); }
        pieces.push('<rect x="' + x + '" y="' + y + '" width="' + nodeWidth + '" height="' + nodeHeight + '" rx="12" fill="' + element.style.fill + '" stroke="' + element.style.stroke + '"/>');
        pieces.push('<text x="' + (x + nodeWidth / 2) + '" y="' + (y + nodeHeight / 2 + element.style.fontSize * 0.35) + '" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="' + element.style.fontSize + '" fill="' + element.style.textColor + '">' + escapeXml(text) + '</text>');
    });
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L6,3 z" fill="' + element.style.stroke + '"/></marker></defs>' + pieces.join('') + '</svg>';
}

function transitionXml(transition) {
    if (!transition || transition.type === 'none') return '';
    const speed = transition.durationMs <= 400 ? 'fast' : transition.durationMs >= 1200 ? 'slow' : 'med';
    const directionMap = { left: 'l', right: 'r', up: 'u', down: 'd', in: 'in', out: 'out' };
    const direction = directionMap[String(transition.direction || '').toLowerCase()] || '';
    const type = transition.type;
    const inner = type === 'fade' ? '<p:fade/>' : type === 'split' ? '<p:split' + (direction ? ' dir="' + direction + '"' : '') + '/>' : '<p:' + type + (direction ? ' dir="' + direction + '"' : '') + '/>';
    return '<p:transition spd="' + speed + '" advClick="1">' + inner + '</p:transition>';
}

async function applyPptxTransitions(buffer, presentation) {
    if (!presentation.slides.some(slide => slide.transition?.type && slide.transition.type !== 'none')) return buffer;
    const zip = await JSZip.loadAsync(buffer);
    for (let index = 0; index < presentation.slides.length; index += 1) {
        const transition = transitionXml(presentation.slides[index].transition); if (!transition) continue;
        const name = 'ppt/slides/slide' + (index + 1) + '.xml'; const file = zip.file(name); if (!file) continue;
        const xml = await file.async('string');
        const clean = xml.replace(/<p:transition\b[\s\S]*?<\/p:transition>|<p:transition\b[^>]*\/>/g, '');
        zip.file(name, clean.replace('</p:sld>', transition + '</p:sld>'));
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
    const pieces = [`<rect x="0" y="0" width="${presentation.width}" height="${presentation.height}" fill="${slide.background.fill}"/>`];
    const backgroundData = await resolveDataUri(slide.background.imageAssetRef, options.assetResolver);
    if (backgroundData) pieces.push(`<image href="${backgroundData}" x="0" y="0" width="${presentation.width}" height="${presentation.height}" opacity="${slide.background.opacity}" preserveAspectRatio="xMidYMid slice"/>`);
    for (const element of slide.elements.filter(item => item.visible)) {
        if (element.type === 'shape') {
            const fillOpacity = element.style.opacity;
            if (element.shapeType === 'ellipse') {
                pieces.push(`<ellipse cx="${element.x + element.width / 2}" cy="${element.y + element.height / 2}" rx="${element.width / 2}" ry="${element.height / 2}" fill="${element.style.fill}" fill-opacity="${fillOpacity}" stroke="${element.style.stroke}" stroke-width="${element.style.strokeWidth}" transform="rotate(${element.rotation} ${element.x + element.width / 2} ${element.y + element.height / 2})"/>`);
            } else if (element.shapeType === 'line') {
                pieces.push(`<line x1="${element.x}" y1="${element.y}" x2="${element.x + element.width}" y2="${element.y + element.height}" stroke="${element.style.stroke}" stroke-width="${element.style.strokeWidth}"/>`);
            } else {
                const radius = element.shapeType === 'roundRect' ? Math.min(element.style.radius, element.width / 2, element.height / 2) : 0;
                pieces.push(`<rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" rx="${radius}" fill="${element.style.fill}" fill-opacity="${fillOpacity}" stroke="${element.style.stroke}" stroke-width="${element.style.strokeWidth}" transform="rotate(${element.rotation} ${element.x + element.width / 2} ${element.y + element.height / 2})"/>`);
            }
            continue;
        }
        if (element.type === 'image') {
            const data = await resolveDataUri(element.assetRef, options.assetResolver);
            if (data) pieces.push(`<image href="${data}" x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" opacity="${element.opacity}" preserveAspectRatio="xMidYMid ${element.fit === 'contain' ? 'meet' : element.fit === 'stretch' ? 'none' : 'slice'}"/>`);
            continue;
        }
        if (element.type === 'media') {
            const poster = await resolveDataUri(element.posterAssetRef, options.assetResolver);
            if (poster) pieces.push('<image href="' + poster + '" x="' + element.x + '" y="' + element.y + '" width="' + element.width + '" height="' + element.height + '" preserveAspectRatio="xMidYMid meet"/>');
            pieces.push('<rect x="' + element.x + '" y="' + element.y + '" width="' + element.width + '" height="' + element.height + '" rx="10" fill="' + (poster ? '#000000' : '#0F172A') + '" fill-opacity="' + (poster ? '0.22' : '1') + '" stroke="#64748B"/>');
            pieces.push('<text x="' + (element.x + element.width / 2) + '" y="' + (element.y + element.height / 2) + '" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="22" fill="#FFFFFF">' + (element.mediaType === 'audio' ? '🔊 音频' : '▶ 视频') + '</text>');
            continue;
        }
        if (element.type === 'attachment') {
            pieces.push('<rect x="' + element.x + '" y="' + element.y + '" width="' + element.width + '" height="' + element.height + '" rx="8" fill="#F8FAFC" stroke="#64748B"/>');
            pieces.push('<text x="' + (element.x + 14) + '" y="' + (element.y + 28) + '" font-family="Microsoft YaHei, sans-serif" font-size="16" fill="#1E293B">📎 ' + escapeXml(element.filename) + '</text>');
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
        const lines = wrapText(element.content.text, Math.max(3, Math.floor((element.width - element.style.padding * 2) / Math.max(1, element.style.fontSize * 0.58))));
        const align = element.style.align === 'center' ? 'middle' : element.style.align === 'right' ? 'end' : 'start';
        const textX = element.style.align === 'center' ? element.x + element.width / 2 : element.style.align === 'right' ? element.x + element.width - element.style.padding : element.x + element.style.padding;
        const startY = element.y + element.style.padding + element.style.fontSize;
        const weight = element.style.fontWeight >= 600 ? '700' : '400';
        pieces.push(`<text x="${textX}" y="${startY}" text-anchor="${align}" font-family="${escapeXml(element.style.fontFamily)}, Microsoft YaHei, Noto Sans SC, sans-serif" font-size="${element.style.fontSize}" font-weight="${weight}" fill="${element.style.color}" transform="rotate(${element.rotation} ${element.x + element.width / 2} ${element.y + element.height / 2})">${lines.map((line, index) => `<tspan x="${textX}" dy="${index ? element.style.fontSize * element.style.lineHeight : 0}">${escapeXml(line)}</tspan>`).join('')}</text>`);
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
    const chars = Math.max(3, Math.floor(maxWidth / Math.max(1, size * 0.72)));
    const lines = wrapText(text, chars);
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
                const fill = hexToRgb(element.style.fill);
                const stroke = hexToRgb(element.style.stroke);
                if (element.shapeType === 'line') {
                    page.drawLine({ start: { x: element.x * 0.75, y: height - element.y * 0.75 }, end: { x: (element.x + element.width) * 0.75, y: height - (element.y + element.height) * 0.75 }, thickness: element.style.strokeWidth, color: rgb(stroke.r, stroke.g, stroke.b) });
                } else if (element.shapeType === 'ellipse') {
                    page.drawEllipse({ x: (element.x + element.width / 2) * 0.75, y: height - (element.y + element.height / 2) * 0.75, xScale: element.width * 0.375, yScale: element.height * 0.375, color: rgb(fill.r, fill.g, fill.b), borderColor: rgb(stroke.r, stroke.g, stroke.b), borderWidth: element.style.strokeWidth });
                } else {
                    page.drawRectangle({ x: element.x * 0.75, y, width: element.width * 0.75, height: element.height * 0.75, color: rgb(fill.r, fill.g, fill.b), opacity: element.style.opacity, borderColor: rgb(stroke.r, stroke.g, stroke.b), borderWidth: element.style.strokeWidth });
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
    const widthIn = presentation.aspectRatio === '4:3' ? 10 : 13.333;
    const heightIn = 7.5;
    return { x: element.x / presentation.width * widthIn, y: element.y / presentation.height * heightIn, w: element.width / presentation.width * widthIn, h: element.height / presentation.height * heightIn };
}

async function renderPptx(presentation, options = {}) {
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
                slide.addText(element.content.text, {
                    ...pos, margin: element.style.padding / 72, fontFace: element.style.fontFamily, fontSize: element.style.fontSize * 0.75,
                    bold: element.style.fontWeight >= 600, italic: element.style.italic, underline: element.style.underline,
                    color: pptColor(element.style.color), align: element.style.align, valign: element.style.verticalAlign,
                    breakLine: false, fit: 'shrink', rotate: element.rotation, paraSpaceAfterPt: 0,
                    bullet: element.style.bullet ? { type: 'ul' } : undefined
                });
                continue;
            }
            if (element.type === 'shape') {
                const shape = pptx.ShapeType[element.shapeType] || pptx.ShapeType.rect;
                slide.addShape(shape, {
                    ...pos, rotate: element.rotation, fill: { color: pptColor(element.style.fill), transparency: Math.round((1 - element.style.opacity) * 100) },
                    line: { color: pptColor(element.style.stroke), width: element.style.strokeWidth }
                });
                continue;
            }
            if (element.type === 'table') {
                slide.addTable([element.columns, ...element.rows], {
                    ...pos, border: { type: 'solid', color: pptColor(element.style.borderColor), pt: 0.5 },
                    fontFace: presentation.theme.fonts.body, fontSize: element.style.fontSize * 0.75,
                    color: pptColor(element.style.cellColor), fill: pptColor(element.style.cellFill),
                    bold: false, margin: 0.05,
                    rowH: pos.h / Math.max(1, element.rows.length + 1),
                    autoFit: false
                });
                continue;
            }
            if (element.type === 'image') {
                const asset = await options.assetResolver?.(element.assetRef);
                if (!asset?.buffer || !asset?.mimeType) continue;
                const data = await resolveDataUri(element.assetRef, async () => asset);
                slide.addImage({ data, ...pos, transparency: Math.round((1 - element.opacity) * 100) });
                continue;
            }
            if (element.type === 'media') {
                const asset = await options.assetResolver?.(element.assetRef);
                if (asset?.buffer && asset?.mimeType) {
                    try { slide.addMedia({ type: element.mediaType, data: rawDataUri(asset), ext: mediaExtension(asset.mimeType, element.mediaType === 'audio' ? 'mp3' : 'mp4'), ...pos }); }
                    catch (_) { slide.addShape(pptx.ShapeType.rect, { ...pos, fill: { color: '0F172A' }, line: { color: '64748B', width: 1 } }); slide.addText(element.mediaType === 'audio' ? '音频媒体' : '视频媒体', { ...pos, color: 'FFFFFF', fontSize: 14, align: 'center', valign: 'mid' }); }
                }
                continue;
            }
            if (element.type === 'attachment') {
                slide.addShape(pptx.ShapeType.roundRect, { ...pos, rectRadius: 0.08, fill: { color: 'F8FAFC' }, line: { color: '64748B', width: 1 } });
                slide.addText('附件：' + element.filename, { ...pos, margin: 0.08, color: '1E293B', fontSize: 11, valign: 'mid' });
                continue;
            }
            if (element.type === 'diagram') {
                const count = element.items.length; const horizontal = element.diagramType !== 'hierarchy';
                const gap = 0.12; const nodeW = horizontal ? Math.max(0.8, (pos.w - gap * (count - 1)) / count) : Math.max(1.2, pos.w * 0.45); const nodeH = horizontal ? Math.max(0.45, pos.h * 0.55) : Math.max(0.35, (pos.h - gap * (count - 1)) / count);
                element.items.forEach((text, index) => { const x = horizontal ? pos.x + index * (nodeW + gap) : pos.x + (pos.w - nodeW) / 2; const y = horizontal ? pos.y + (pos.h - nodeH) / 2 : pos.y + index * (nodeH + gap); if (index > 0) { const prevX = horizontal ? x - gap : pos.x + pos.w / 2; const prevY = horizontal ? pos.y + pos.h / 2 : y - gap; const nextX = horizontal ? x - 0.04 : pos.x + pos.w / 2; const nextY = horizontal ? pos.y + pos.h / 2 : y - 0.04; slide.addShape(pptx.ShapeType.line, { x: prevX, y: prevY, w: nextX - prevX, h: nextY - prevY, line: { color: pptColor(element.style.stroke), width: 1.5, beginArrowType: 'none', endArrowType: 'triangle' } }); } slide.addShape(pptx.ShapeType.roundRect, { x, y, w: nodeW, h: nodeH, fill: { color: pptColor(element.style.fill) }, line: { color: pptColor(element.style.stroke), width: 1 } }); slide.addText(text, { x, y, w: nodeW, h: nodeH, margin: 0.03, color: pptColor(element.style.textColor), fontSize: element.style.fontSize * 0.75, align: 'center', valign: 'mid', fit: 'shrink' }); });
                continue;
            }
            if (element.type === 'chart') {
                const categories = element.data.rows.map(row => String(row[0]));
                const series = element.data.columns.slice(1).map((name, seriesIndex) => ({ name, labels: categories, values: element.data.rows.map(row => Number(row[seriesIndex + 1]) || 0) }));
                const chartType = pptx.ChartType[element.chartType] || pptx.ChartType.bar;
                try {
                    slide.addChart(chartType, series, { ...pos, catAxisLabelFontFace: presentation.theme.fonts.body, valAxisLabelFontFace: presentation.theme.fonts.body, showLegend: element.options.showLegend, showValue: element.options.showLabels, showTitle: Boolean(element.title), title: element.title || undefined, chartColors: element.options.colors.map(pptColor), showCatName: false });
                } catch (_) {
                    const chartData = await sharp(Buffer.from(createChartSvg(element, Math.round(element.width), Math.round(element.height)))).png().toBuffer();
                    slide.addImage({ data: `data:image/png;base64,${chartData.toString('base64')}`, ...pos });
                }
            }
        }
        if (options.includeNotes !== false && slideData.speakerNotes) slide.addNotes(slideData.speakerNotes.split('\n'));
    }
    const raw = await pptx.write({ outputType: 'nodebuffer' });
    return await applyPptxTransitions(Buffer.from(raw), presentation);
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
    } else if (normalizedFormat === 'png') {
        buffer = await renderPng(presentation, options);
        mimeType = PNG_MIME;
    } else {
        const error = new Error('仅支持导出 PPTX、PDF 或 PNG。');
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
