const CJK_RUN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu;
const SPLIT_PATTERN = /[^\p{L}\p{N}\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/u;
const DEFAULT_NGRAM_MIN = 1;
const DEFAULT_NGRAM_MAX = 3;

function uniq(items) {
    return [...new Set(items.filter(Boolean))];
}

function normalizeSearchText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function extractCjkRuns(text) {
    return String(text || '').match(CJK_RUN_PATTERN) || [];
}

function buildCjkNgrams(text, minSize = DEFAULT_NGRAM_MIN, maxSize = DEFAULT_NGRAM_MAX) {
    const tokens = [];
    extractCjkRuns(text).forEach(run => {
        const max = Math.min(maxSize, run.length);
        for (let size = minSize; size <= max; size += 1) {
            for (let i = 0; i <= run.length - size; i += 1) {
                tokens.push(run.slice(i, i + size));
            }
        }
    });
    return uniq(tokens);
}

function buildRagSearchContent(text) {
    const normalized = normalizeSearchText(text);
    const cjkTokens = buildCjkNgrams(normalized);
    if (cjkTokens.length === 0) return normalized;
    return `${normalized}\n${cjkTokens.join(' ')}`;
}

function buildRagSearchTerms(query, limit = 32) {
    const normalized = normalizeSearchText(query);
    if (!normalized) return [];

    const lexicalTerms = normalized
        .split(SPLIT_PATTERN)
        .map(item => item.trim())
        .filter(item => item.length >= 2);
    const cjkTerms = buildCjkNgrams(normalized);

    return uniq([...lexicalTerms, ...cjkTerms])
        .sort((a, b) => b.length - a.length)
        .slice(0, limit);
}

module.exports = {
    buildCjkNgrams,
    buildRagSearchContent,
    buildRagSearchTerms,
    normalizeSearchText
};
