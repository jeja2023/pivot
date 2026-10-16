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

// 对“抢劫罪判几年”“涉嫌故意伤害罪”等法律问法，罪名及去掉“罪”后的核心词
// 是不可被“可以、判处、犯罪”等泛词替代的相关性锚点。这里只提取明确罪名，
// 普通知识库问题仍沿用原有的宽召回逻辑。
function buildRagRequiredTerms(query, limit = 4) {
    const normalized = normalizeSearchText(query);
    const terms = [];
    extractCjkRuns(normalized).forEach(run => {
        for (let index = 0; index < run.length; index += 1) {
            if (run[index] !== '罪') continue;
            const before = run.slice(0, index + 1);
            const introduced = before.match(/(?:触犯|犯了|构成|涉嫌|实施|犯)([\u3400-\u4dbf\u4e00-\u9fff]{2,10}罪)$/u);
            const candidate = (introduced?.[1] || before)
                .replace(/^(?:请问|请|关于|对于|如果|是否|怎么|如何|触犯|犯了|构成|涉嫌|实施|犯)+/u, '')
                .trim();
            if (candidate.length < 3 || candidate.length > 10 || ['犯罪', '有罪', '无罪'].includes(candidate)) continue;
            terms.push(candidate);
            const core = candidate.slice(0, -1);
            if (core.length >= 2) terms.push(core);
        }
    });
    return uniq(terms).sort((a, b) => b.length - a.length).slice(0, limit);
}

// 检索索引会把下划线、路径分隔符等编码成 `zsym...z`，以便 PostgreSQL
// simple FTS 能够精确匹配。这些内部词元不能直接呈现给用户，因此调试界面
// 使用独立的、未经编码的展示词列表。
function buildRagDisplayTerms(query, limit = 8) {
    const normalized = normalizeSearchText(query);
    if (!normalized) return [];
    const lexicalTerms = normalized
        .split(SPLIT_PATTERN)
        .map(item => item.trim())
        .filter(item => item.length >= 2);
    const cjkPhrases = extractCjkRuns(normalized)
        .map(item => item.trim())
        .filter(item => item.length >= 2);
    return uniq([...lexicalTerms, ...cjkPhrases])
        .sort((a, b) => b.length - a.length || a.localeCompare(b, 'zh-CN'))
        .slice(0, limit);
}

module.exports = {
    buildCjkNgrams,
    buildRagDisplayTerms,
    buildRagRequiredTerms,
    buildSymbolicSearchTerms,
    buildRagSearchContent,
    buildRagSearchTerms,
    normalizeSearchText
};
