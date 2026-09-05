const fs = require('fs');
const path = require('path');

const { queryOne } = require('../../../db/client');
const { getBeijingTimestamp } = require('../../../time');
const { OUTPUT_TYPES } = require('../constants');
const { buildManagedPath, outputsRoot, resolveStoredDocumentPath, toProjectRelativePath } = require('../paths');

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeParseJson(value, fallback = null) {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch (_err) {
        return fallback;
    }
}

function baseName(value) {
    const raw = path.basename(String(value || 'ocr-result'), path.extname(String(value || ''))).trim() || 'ocr-result';
    return raw.replace(/[\\/:*?"<>|\0\r\n\t]/g, ' ').replace(/\s+/g, ' ').slice(0, 80) || 'ocr-result';
}

function outputTypeMeta(type) {
    if (type === OUTPUT_TYPES.MARKDOWN) return { extension: '.md', mimeType: 'text/markdown; charset=utf-8' };
    if (type === OUTPUT_TYPES.JSON) return { extension: '.json', mimeType: 'application/json; charset=utf-8' };
    if (type === OUTPUT_TYPES.HTML) return { extension: '.html', mimeType: 'text/html; charset=utf-8' };
    if (type === OUTPUT_TYPES.DOCX) return { extension: '.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    if (type === OUTPUT_TYPES.SEARCHABLE_PDF) return { extension: '.pdf', mimeType: 'application/pdf' };
    return { extension: '.txt', mimeType: 'text/plain; charset=utf-8' };
}

function serializeOutput(row) {
    if (!row) return null;
    return {
        id: row.id,
        jobId: row.job_id,
        fileId: row.file_id,
        outputType: row.output_type,
        fileName: row.file_name,
        mimeType: row.mime_type,
        fileSize: Number(row.file_size || 0),
        status: row.status,
        createdAt: row.created_at
    };
}

async function registerOutput({ userId, fileId, jobId, outputType, filePath, fileName, mimeType, status = 'ready' }) {
    const stat = await fs.promises.stat(filePath).catch(() => ({ size: 0 }));
    return await queryOne(`
        INSERT INTO document_outputs (
            user_id, file_id, job_id, output_type, file_path, file_name, mime_type, file_size, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
    `, [
        userId,
        fileId,
        jobId,
        outputType,
        toProjectRelativePath(filePath),
        fileName,
        mimeType,
        stat.size,
        status,
        getBeijingTimestamp()
    ]);
}

async function writeOutputFile({ userId, fileId, jobId, originalName, outputType, content }) {
    const meta = outputTypeMeta(outputType);
    const diskName = String(jobId) + '-' + String(outputType) + '-' + Date.now() + meta.extension;
    const targetPath = await buildManagedPath(outputsRoot, userId, diskName);
    if (Buffer.isBuffer(content)) await fs.promises.writeFile(targetPath, content);
    else await fs.promises.writeFile(targetPath, String(content || ''), 'utf8');
    const fileName = baseName(originalName) + '-' + outputType + meta.extension;
    return await registerOutput({
        userId,
        fileId,
        jobId,
        outputType,
        filePath: targetPath,
        fileName,
        mimeType: meta.mimeType
    });
}

function pagesToText(pages = []) {
    return pages
        .map(page => String(page.text || '').trim())
        .filter(Boolean)
        .join('\n\n')
        .trim();
}

function buildMarkdown({ file, text }) {
    const title = baseName(file?.original_name || file?.originalName || 'ocr-result');
    return ['# ' + title, '', String(text || '').trim()].join('\n').trim() + '\n';
}

function parseBlockBbox(block) {
    return safeParseJson(block?.bbox_json, block?.bbox || []) || [];
}

function buildJson({ file, job, pages = [], blocks = [] }) {
    const payload = {
        file: {
            id: file.id,
            originalName: file.original_name || file.originalName || '',
            fileType: file.file_type || file.fileType || '',
            pageCount: Number(file.page_count || file.pageCount || pages.length || 0)
        },
        job: {
            id: job.id,
            jobType: job.job_type || job.jobType || '',
            status: job.status || ''
        },
        pages: pages.map(page => ({
            id: page.id,
            pageNumber: Number(page.page_number || page.pageNumber || 1),
            width: Number(page.width || 0),
            height: Number(page.height || 0),
            text: page.text || '',
            confidence: page.confidence ?? null,
            ocrStatus: page.ocr_status || page.ocrStatus || ''
        })),
        blocks: blocks.map(block => ({
            id: block.id,
            pageId: block.page_id || block.pageId,
            pageNumber: Number(block.page_number || block.pageNumber || 1),
            sortOrder: Number(block.sort_order || block.sortOrder || 0),
            text: block.text || '',
            bbox: parseBlockBbox(block),
            confidence: Number(block.confidence || 0),
            language: block.language || '',
            engine: block.engine || ''
        }))
    };
    return JSON.stringify(payload, null, 2);
}

function imageMimeType(filePath) {
    const ext = path.extname(filePath || '').toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.bmp') return 'image/bmp';
    return 'image/png';
}

async function imageDataUri(page) {
    const imagePath = resolveStoredDocumentPath(page?.image_path || page?.imagePath || '');
    if (!imagePath) return '';
    try {
        return 'data:' + imageMimeType(imagePath) + ';base64,' + (await fs.promises.readFile(imagePath)).toString('base64');
    } catch (_err) {
        return '';
    }
}

function bboxToRect(bbox) {
    if (!Array.isArray(bbox) || !bbox.length) return null;
    if (Array.isArray(bbox[0])) {
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
        return { x: minX, y: minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
    }
    if (bbox.length >= 4) {
        const x = Number(bbox[0]);
        const y = Number(bbox[1]);
        const third = Number(bbox[2]);
        const fourth = Number(bbox[3]);
        if (![x, y, third, fourth].every(Number.isFinite)) return null;
        const width = third > x ? third - x : third;
        const height = fourth > y ? fourth - y : fourth;
        return { x, y, width: Math.max(width, 1), height: Math.max(height, 1) };
    }
    return null;
}

function pct(value, total) {
    const n = Number(value || 0);
    const d = Math.max(Number(total || 0), 1);
    return Math.min(Math.max((n / d) * 100, 0), 100).toFixed(4) + '%';
}

function groupBlocksByPage(blocks = []) {
    const map = new Map();
    blocks.forEach(block => {
        const pageId = Number(block.page_id || block.pageId || 0);
        const list = map.get(pageId) || [];
        list.push(block);
        map.set(pageId, list);
    });
    return map;
}

function renderOverlayBlocks({ page, blocks }) {
    const width = Number(page.width || 0) || 1;
    const height = Number(page.height || 0) || 1;
    return blocks.map(block => {
        const rect = bboxToRect(parseBlockBbox(block));
        if (!rect) return '';
        const confidence = Number(block.confidence || 0);
        const classes = confidence > 0 && confidence < 0.75 ? 'ocr-box is-low' : 'ocr-box';
        const style = [
            'left:' + pct(rect.x, width),
            'top:' + pct(rect.y, height),
            'width:' + pct(rect.width, width),
            'height:' + pct(rect.height, height)
        ].join(';');
        return '<span class="' + classes + '" style="' + style + '" title="' + escapeHtml(Math.round(confidence * 100) + '% ' + String(block.text || '').slice(0, 80)) + '"></span>';
    }).join('');
}

async function renderHtmlPage({ page, blocks }) {
    const pageNumber = Number(page.page_number || page.pageNumber || 1);
    const width = Math.max(Number(page.width || 0), 1);
    const height = Math.max(Number(page.height || 0), 1);
    const src = await imageDataUri(page);
    const visual = src
        ? [
            '<div class="page-visual" style="max-width:' + width + 'px;aspect-ratio:' + width + '/' + height + '">',
            '<img alt="page ' + pageNumber + '" src="' + src + '">',
            '<div class="ocr-layer">' + renderOverlayBlocks({ page, blocks }) + '</div>',
            '</div>'
        ].join('')
        : '<div class="page-placeholder">\u6682\u65e0\u9875\u9762\u56fe\u50cf</div>';
    return [
        '<section class="page-section">',
        '<h2>? ' + pageNumber + ' ?</h2>',
        visual,
        '<pre>' + escapeHtml(page.text || '') + '</pre>',
        '</section>'
    ].join('\n');
}

async function buildHtml({ file, pages = [], blocks = [], text }) {
    const title = baseName(file?.original_name || file?.originalName || 'ocr-result');
    const blocksByPage = groupBlocksByPage(blocks);
    const body = pages.length
        ? (await Promise.all(pages.map(page => renderHtmlPage({ page, blocks: blocksByPage.get(Number(page.id)) || [] })))).join('\n')
        : '<pre>' + escapeHtml(text || '') + '</pre>';
    return [
        '<!DOCTYPE html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="UTF-8">',
        '<title>' + escapeHtml(title) + '</title>',
        '<style>',
        'body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.7;margin:32px;color:#111827;background:#f8fafc;}',
        'h1,h2{line-height:1.35;margin:0 0 16px;}',
        '.page-section{margin:0 0 28px;padding:20px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;}',
        '.page-visual{position:relative;width:100%;margin:0 0 16px;background:#e5e7eb;border-radius:6px;overflow:hidden;}',
        '.page-visual img{display:block;width:100%;height:100%;object-fit:contain;}',
        '.ocr-layer{position:absolute;inset:0;pointer-events:none;}',
        '.ocr-box{position:absolute;border:1.5px solid rgba(37,99,235,.85);background:rgba(37,99,235,.09);box-sizing:border-box;}',
        '.ocr-box.is-low{border-color:rgba(217,119,6,.95);background:rgba(245,158,11,.18);}',
        '.page-placeholder{display:grid;place-items:center;min-height:160px;border:1px dashed #cbd5e1;border-radius:6px;color:#64748b;}',
        'pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:0;}',
        '</style>',
        '</head>',
        '<body>',
        '<h1>' + escapeHtml(title) + '</h1>',
        body,
        '</body>',
        '</html>',
        ''
    ].join('\n');
}

function createCrcTable() {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c >>> 0;
    }
    return table;
}

const CRC_TABLE = createCrcTable();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
    const year = Math.max(date.getFullYear(), 1980);
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    return { dosDate, dosTime };
}

function createZip(entries) {
    const localParts = [];
    const centralParts = [];
    const { dosDate, dosTime } = dosDateTime();
    let offset = 0;
    entries.forEach(entry => {
        const name = Buffer.from(entry.name, 'utf8');
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data || ''), 'utf8');
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(dosTime, 10);
        local.writeUInt16LE(dosDate, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        localParts.push(local, name, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(dosTime, 12);
        central.writeUInt16LE(dosDate, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, name);
        offset += local.length + name.length + data.length;
    });
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...localParts, ...centralParts, end]);
}

/**
 * OCR / 文本抽取结果导出 DOCX。
 *
 * 落地方案 v1.2 §7.2 与阶段 2.4：原实现是手写最小 OOXML（无样式表、无表格、
 * 无页眉页脚，且页码行字面写着损坏的 ASCII 问号占位），现已整体迁移为
 * 「OCR pages → Document IR → 统一渲染器」，使 DOCX 出口在全项目唯一。
 * 页码文案同时修复为「第 N 页」。
 */
async function buildDocx({ file, pages = [], text = '' }) {
    const { renderDocumentIr } = require('../../document-rendering');
    const title = baseName(file?.original_name || file?.originalName || 'ocr-result');
    const sourcePages = pages.length ? pages : [{ page_number: 1, text }];
    const blocks = [{ type: 'heading', level: 1, text: title }];
    sourcePages.forEach((page, index) => {
        if (index > 0) blocks.push({ type: 'page_break' });
        const pageNumber = Number(page.page_number || page.pageNumber || index + 1);
        blocks.push({ type: 'heading', level: 2, text: `第 ${pageNumber} 页` });
        String(page.text || '')
            .split(/\r?\n/)
            .forEach(paragraph => blocks.push({ type: 'paragraph', runs: [{ text: paragraph }] }));
    });
    const rendered = await renderDocumentIr({
        ir_version: '1',
        doc_type: 'report',
        meta: { title, issuer: 'Pivot 文字识别' },
        blocks,
        footer: { page_number: true, format: '第 {page} 页' }
    }, 'docx');
    return rendered.buffer;
}

async function createTextOutputs({ userId, file, job, text = '', pages = [], blocks = [], formats = [OUTPUT_TYPES.TEXT, OUTPUT_TYPES.MARKDOWN, OUTPUT_TYPES.JSON] }) {
    const finalText = String(text || pagesToText(pages) || '').trim();
    const outputs = [];
    for (const format of formats) {
        if (format === OUTPUT_TYPES.MARKDOWN) {
            outputs.push(await writeOutputFile({ userId, fileId: file.id, jobId: job.id, originalName: file.original_name, outputType: format, content: buildMarkdown({ file, text: finalText }) }));
        } else if (format === OUTPUT_TYPES.JSON) {
            outputs.push(await writeOutputFile({ userId, fileId: file.id, jobId: job.id, originalName: file.original_name, outputType: format, content: buildJson({ file, job, pages, blocks }) }));
        } else if (format === OUTPUT_TYPES.HTML) {
            outputs.push(await writeOutputFile({ userId, fileId: file.id, jobId: job.id, originalName: file.original_name, outputType: format, content: await buildHtml({ file, pages, blocks, text: finalText }) }));
        } else if (format === OUTPUT_TYPES.DOCX) {
            outputs.push(await writeOutputFile({ userId, fileId: file.id, jobId: job.id, originalName: file.original_name, outputType: format, content: await buildDocx({ file, pages, text: finalText }) }));
        } else {
            outputs.push(await writeOutputFile({ userId, fileId: file.id, jobId: job.id, originalName: file.original_name, outputType: OUTPUT_TYPES.TEXT, content: finalText + '\n' }));
        }
    }
    return outputs.map(serializeOutput);
}

module.exports = {
    buildDocx,
    buildHtml,
    buildJson,
    buildMarkdown,
    createTextOutputs,
    createZip,
    escapeHtml,
    outputTypeMeta,
    pagesToText,
    registerOutput,
    serializeOutput,
    writeOutputFile
};
