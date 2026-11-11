const { query, queryOne, execute } = require('../../db/client');
const { normalizeRegulationId, normalizeRegulationText } = require('./shared');
const { pagesForChunk } = require('../knowledge-page-locator');

// pdf-parse 的新版文本提取会在每页末尾写入 “-- 1 of 3 --”；OCR 和
// 人工导入常见的 form-feed/“[第 1 页]”则标识下一段的页首。三种标记都要
// 识别，才能让法规条文跳转到真实 PDF 页而不是一律落在第一页。
const PAGE_MARKER_RE = /(\f)|\[\s*第\s*(\d+)\s*页[^\]]*\]|--\s*(\d+)\s+of\s+\d+\s*--/g;

function inferRegulationPageNumber(text, charOffset = 0) {
    const source = String(text || '');
    const before = source.slice(0, Math.max(0, Number(charOffset) || 0));
    let page = 1;
    let match;
    PAGE_MARKER_RE.lastIndex = 0;
    while ((match = PAGE_MARKER_RE.exec(before))) {
        if (match[1]) page += 1;
        else if (match[2]) page = Number(match[2]);
        else if (match[3]) page = Number(match[3]) + 1;
    }
    return Math.max(1, Number(page) || 1);
}

function deriveArticleLocations(articles, extractedText = '', pageSpans = []) {
    const source = String(extractedText || '');
    let cursor = 0;
    let normalized = null, normalizedCursor = 0;
    return (Array.isArray(articles) ? articles : []).map(article => {
        const content = normalizeRegulationText(article?.content || '');
        const found = content ? source.indexOf(content, cursor) : -1;
        let charStart = found >= 0 ? found : cursor, charEnd = charStart + content.length;
        let located = found >= 0;
        if (!located && content) {
            if (!normalized) {
                const characters = [], offsets = [];
                let space = false;
                for (let index = 0; index < source.length; index++) {
                    const whitespace = /\s/u.test(source[index]);
                    if (!whitespace || !space) { characters.push(whitespace ? ' ' : source[index]); offsets.push(index); }
                    space = whitespace;
                }
                normalized = { text: characters.join(''), offsets };
            }
            while (normalizedCursor < normalized.offsets.length && normalized.offsets[normalizedCursor] < cursor) normalizedCursor++;
            const compact = content.replace(/\s+/g, ' ').trim(), match = normalized.text.indexOf(compact, normalizedCursor);
            if (match >= 0) { charStart = normalized.offsets[match]; charEnd = normalized.offsets[match + compact.length - 1] + 1; located = true; }
        }
        cursor = Math.max(cursor, charEnd);
        const pages = pagesForChunk(pageSpans, charStart, charEnd);
        return {
            sortOrder: Number(article?.sortOrder || article?.sort_order || 0),
            pageNumber: pages[0] || inferRegulationPageNumber(source, charStart),
            pageEnd: pages.at(-1) || inferRegulationPageNumber(source, Math.max(charStart, charEnd - 1)),
            charStart,
            charEnd,
            blockIndex: Number(article?.sortOrder || article?.sort_order || 0) || null,
            confidence: located ? 1 : 0.4
        };
    });
}

async function saveRegulationArticleLocations({ articleIdsBySortOrder, articles, extractedText, pageSpans = [], executor = execute }) {
    const locations = deriveArticleLocations(articles, extractedText, pageSpans);
    for (const location of locations) {
        const articleId = articleIdsBySortOrder.get(location.sortOrder);
        if (!articleId) continue;
        await executor(`
            INSERT INTO regulation_article_locations (
                article_id, page_number, char_start, char_end, block_index, bbox_json, confidence
            ) VALUES (?, ?, ?, ?, ?, '{}'::jsonb, ?)
        `, [articleId, location.pageNumber, location.charStart, location.charEnd, location.blockIndex, location.confidence]);
        await executor('UPDATE regulation_articles SET page_start = ?, page_end = ? WHERE id = ?', [location.pageNumber, location.pageEnd, articleId]);
    }
    return locations.length;
}

async function listRegulationArticleLocations({ articleId }) {
    const normalizedArticleId = normalizeRegulationId(articleId);
    if (!normalizedArticleId) return [];
    return await query(`
        SELECT id, article_id, page_number, char_start, char_end, block_index, bbox_json, confidence, created_at
        FROM regulation_article_locations
        WHERE article_id = ?
        ORDER BY page_number ASC, block_index ASC, id ASC
    `, [normalizedArticleId]);
}

async function getRegulationArticleLocation({ articleId }) {
    const normalizedArticleId = normalizeRegulationId(articleId);
    if (!normalizedArticleId) return null;
    return await queryOne(`
        SELECT id, article_id, page_number, char_start, char_end, block_index, bbox_json, confidence, created_at
        FROM regulation_article_locations
        WHERE article_id = ?
        ORDER BY page_number ASC, block_index ASC, id ASC
        LIMIT 1
    `, [normalizedArticleId]);
}

module.exports = {
    deriveArticleLocations,
    getRegulationArticleLocation,
    listRegulationArticleLocations,
    saveRegulationArticleLocations
};
