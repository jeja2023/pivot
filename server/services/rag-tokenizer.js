const CJK_RUN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu;
const SPLIT_PATTERN = /[^\p{L}\p{N}\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/u;
const SYMBOLIC_TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}._:/#@+\-$]{1,}/gu;
const SYMBOL_PATTERN = /[._:/#@+\-$]/u;
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

function encodeSymbolicSearchTerm(value) {
    return Array.from(String(value || '').toLowerCase())
        .map(char => SYMBOL_PATTERN.test(char) ? ` zsym${char.codePointAt(0).toString(16)}z ` : char)
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildSymbolicSearchTerms(text) {
    return uniq((String(text || '').match(SYMBOLIC_TOKEN_PATTERN) || [])
        .filter(term => SYMBOL_PATTERN.test(term))
        .map(encodeSymbolicSearchTerm)
        .filter(Boolean));
}

function buildRagSearchContent(text) {
    const normalized = normalizeSearchText(text);
    const cjkTokens = buildCjkNgrams(normalized);
    const symbolicTerms = buildSymbolicSearchTerms(normalized);
    const extraTerms = [...cjkTokens, ...symbolicTerms];
    if (extraTerms.length === 0) return normalized;
    return `${normalized}\n${extraTerms.join('\n')}`;
}

function buildRagSearchTerms(query, limit = 32) {
    const normalized = normalizeSearchText(query);
    if (!normalized) return [];

    const lexicalTerms = normalized
        .split(SPLIT_PATTERN)
        .map(item => item.trim())
        .filter(item => item.length >= 2);
    const cjkTerms = buildCjkNgrams(normalized);
    const symbolicTerms = buildSymbolicSearchTerms(normalized);

    return uniq([...symbolicTerms, ...lexicalTerms, ...cjkTerms])
        .sort((a, b) => b.length - a.length)
        .slice(0, limit);
}

module.exports = {
    buildCjkNgrams,
    buildSymbolicSearchTerms,
    buildRagSearchContent,
    buildRagSearchTerms,
    normalizeSearchText
};
