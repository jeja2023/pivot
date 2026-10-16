'use strict';

const GENERIC_TERMS = new Set([
    '请问', '请', '是否', '能否', '如何', '哪些', '什么', '关于', '对于', '规定', '要求',
    '问题', '相关', '这个', '那个', '本条', '该条', '制度', '法规', '法律', '依据', '处理'
]);

function normalizeEvidenceText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function deriveEvidenceTerms(queries = []) {
    const seen = new Set();
    const terms = [];
    for (const query of queries) {
        const source = String(query || '').toLocaleLowerCase();
        const matches = source.match(/[\u3400-\u9fff]{2,}|[a-z0-9_\-.]{2,}/g) || [];
        for (const raw of matches) {
            const term = raw.trim();
            if (!term || GENERIC_TERMS.has(term) || seen.has(term)) continue;
            seen.add(term);
            terms.push(term);
        }
    }
    return terms.slice(0, 24);
}

function sentenceWindows(text) {
    const result = [];
    const boundary = /[。！？；;\n]/g;
    let start = 0;
    let match;
    while ((match = boundary.exec(text))) {
        const end = match.index + 1;
        if (end > start) result.push({ start, end, text: text.slice(start, end) });
        start = end;
    }
    if (start < text.length) result.push({ start, end: text.length, text: text.slice(start) });
    return result.length ? result : [{ start: 0, end: text.length, text }];
}

// 证据窗口优先围绕最相关句子展开，避免把长条文的开头误当作命中依据。
function buildRegulationEvidenceExcerpt(content, queries = [], { maxLength = 1400, before = 420 } = {}) {
    const text = normalizeEvidenceText(content);
    if (!text) return { excerpt: '', charStart: 0, charEnd: 0, matchedTerms: [] };
    const terms = deriveEvidenceTerms(queries);
    const lower = text.toLocaleLowerCase();
    let best = { score: -1, start: 0, end: Math.min(text.length, maxLength), matchedTerms: [] };
    for (const sentence of sentenceWindows(text)) {
        const sentenceLower = sentence.text.toLocaleLowerCase();
        const matchedTerms = terms.filter(term => sentenceLower.includes(term));
        const score = matchedTerms.length * 100
            + matchedTerms.reduce((sum, term) => sum + Math.min(term.length, 12), 0)
            - Math.min(sentence.text.length, 600) / 10000;
        if (score > best.score) best = { score, start: sentence.start, end: sentence.end, matchedTerms };
    }
    if (!best.matchedTerms.length) {
        const firstTerm = terms.find(term => lower.includes(term));
        if (firstTerm) {
            const index = lower.indexOf(firstTerm);
            best = { score: 1, start: index, end: index + firstTerm.length, matchedTerms: [firstTerm] };
        }
    }
    const safeMax = Math.max(240, Number(maxLength) || 1400);
    const start = Math.max(0, Math.min(best.start - Math.max(0, Number(before) || 0), Math.max(0, text.length - safeMax)));
    const end = Math.min(text.length, start + safeMax);
    return {
        excerpt: `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
        charStart: start,
        charEnd: end,
        matchedTerms: best.matchedTerms
    };
}

module.exports = {
    buildRegulationEvidenceExcerpt,
    deriveEvidenceTerms
};
