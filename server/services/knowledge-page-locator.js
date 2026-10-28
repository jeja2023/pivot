'use strict';

function buildPdfPageSpans(pages = [], maxChars = Number.MAX_SAFE_INTEGER) {
    let cursor = 0;
    return (Array.isArray(pages) ? pages : []).filter(page => String(page.text || '').trim()).map(page => {
        const body = String(page.text).trim();
        const span = { page: Number(page.pageNumber), start: cursor, end: Math.min(cursor + body.length, maxChars) };
        cursor += body.length + 2;
        return span;
    }).filter(span => Number.isSafeInteger(span.page) && span.page > 0 && span.start < maxChars && span.end > span.start);
}

function pagesForChunk(spans = [], start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return [];
    return [...new Set((Array.isArray(spans) ? spans : []).filter(span => Number(span.start) < end && Number(span.end) > start)
        .map(span => Number(span.page)).filter(page => Number.isSafeInteger(page) && page > 0))];
}

module.exports = { buildPdfPageSpans, pagesForChunk };
