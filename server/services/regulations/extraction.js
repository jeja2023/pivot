'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { extractDocumentTextWithOcrFallback } = require('../document-processing/text-extraction');
const { getKnowledgeLimits } = require('../resource-limits');
const { buildPdfPageSpans } = require('../knowledge-page-locator');
const verified = new WeakSet();

function normalizeRegulationText(value, fallback = '') {
    const lines = String(value || fallback || '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').split('\n');
    return lines.map(line => {
        let end = line.length;
        while (end && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
        return line.slice(0, end);
    }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function readRegulationSource(filePath, originalName = '', { extractText = extractDocumentTextWithOcrFallback, ...options } = {}) {
    const limit = getKnowledgeLimits().extractMaxChars;
    let coverage = null;
    const extracted = await extractText(filePath, '', originalName || filePath, { ...options, maxOcrPages: options.maxOcrPages || 10,
        maxChars: limit + 1, onCoverage: result => { coverage = result; } });
    if (String(extracted || '').length > limit) throw Object.assign(new Error(`法规资料提取不完整：正文超过当前 ${limit} 字符的导入范围。请拆分资料后重新导入。`), { status: 422, statusCode: 422, code: 'REGULATION_SOURCE_INCOMPLETE' });
    const pages = coverage?.pages?.map(page => ({ ...page, text: normalizeRegulationText(page.text) }));
    const text = pages ? pages.map(page => page.text).filter(Boolean).join('\n\n') : normalizeRegulationText(extracted);
    if (!text.trim()) throw Object.assign(new Error('法规资料没有可用正文，请检查原文件或先完成文字识别。'), { status: 422, statusCode: 422, code: 'REGULATION_SOURCE_EMPTY' });
    const missing = coverage?.pages?.filter(page => ['omitted', 'unavailable'].includes(page.source)).map(page => page.pageNumber) || [];
    if (text.length > limit || coverage?.coverageComplete === false || missing.length) {
        const detail = missing.length ? `第 ${missing.slice(0, 20).join('、')} 页未完成文字提取。` : `正文超过当前 ${limit} 字符的导入范围。`;
        throw Object.assign(new Error(`法规资料提取不完整：${detail}请先完成文字识别复核或拆分资料后重新导入。`), { status: 422, statusCode: 422, code: 'REGULATION_SOURCE_INCOMPLETE' });
    }
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    const source = Object.freeze({ text, sourceHash: hash.digest('hex'), sourcePageCount: coverage?.sourcePageCount ?? null,
        pageSpans: Object.freeze(buildPdfPageSpans(pages).map(span => Object.freeze(span))) });
    verified.add(source);
    return source;
}

function verifiedRegulationSource(source, sourceHash) { return source && verified.has(source) && source.sourceHash === sourceHash ? source : null; }

module.exports = { readRegulationSource, verifiedRegulationSource, normalizeRegulationText };
