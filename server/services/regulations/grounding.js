const CHINESE_DIGITS = new Map([
    ['零', 0], ['〇', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4],
    ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9]
]);
const CHINESE_UNITS = new Map([['十', 10], ['百', 100], ['千', 1000], ['万', 10000]]);

function normalizeEvidenceText(value) {
    return String(value || '')
        .toLocaleLowerCase()
        .replace(/[\s\u3000，。；、：：“”‘’（）()【】\[\]《》〈〉<>「」『』!！?？,.;:]/g, '');
}

function normalizeLawName(value) {
    return normalizeEvidenceText(value).replace(/^中华人民共和国/, '');
}

function parseArticleNumber(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    if (/^\d+$/.test(text)) return Number(text);
    let total = 0;
    let current = 0;
    let sawNumber = false;
    for (const char of text) {
        if (CHINESE_DIGITS.has(char)) {
            current = CHINESE_DIGITS.get(char);
            sawNumber = true;
            continue;
        }
        const unit = CHINESE_UNITS.get(char);
        if (!unit) return null;
        sawNumber = true;
        if (unit === 10000) {
            total = (total + (current || 0)) * unit;
            current = 0;
        } else {
            total += (current || 1) * unit;
            current = 0;
        }
    }
    return sawNumber ? total + current : null;
}

function normalizeArticleKey(raw) {
    const match = String(raw || '').match(/第\s*([零〇一二两三四五六七八九十百千万\d]+)\s*条(?:\s*之\s*([零〇一二两三四五六七八九十百千万\d]+))?/);
    if (!match) return '';
    const primary = parseArticleNumber(match[1]);
    const suffix = match[2] ? parseArticleNumber(match[2]) : null;
    if (!Number.isSafeInteger(primary) || primary <= 0 || (match[2] && (!Number.isSafeInteger(suffix) || suffix <= 0))) return '';
    return `第${primary}条${suffix ? `之${suffix}` : ''}`;
}

function extractArticleKeys(text) {
    const source = String(text || '');
    const regex = /第\s*[零〇一二两三四五六七八九十百千万\d]+\s*条(?:\s*之\s*[零〇一二两三四五六七八九十百千万\d]+)?/g;
    return [...new Set((source.match(regex) || []).map(normalizeArticleKey).filter(Boolean))];
}

function extractLegalReferences(answer) {
    const text = String(answer || '');
    const references = [];
    const named = /《([^》\n]{2,100})》\s*(第\s*[零〇一二两三四五六七八九十百千万\d]+\s*条(?:\s*之\s*[零〇一二两三四五六七八九十百千万\d]+)?)?/g;
    let match;
    while ((match = named.exec(text))) {
        references.push({
            lawName: String(match[1] || '').trim(),
            articleKey: normalizeArticleKey(match[2] || ''),
            raw: match[0]
        });
    }
    for (const articleKey of extractArticleKeys(text)) {
        if (!references.some(item => item.articleKey === articleKey)) {
            references.push({ lawName: '', articleKey, raw: articleKey });
        }
    }
    return references;
}

function extractSourceCitations(answer) {
    const citations = [];
    const regex = /(?:\[|【)\s*(?:来源|依据|条文)?\s*(\d{1,2})\s*(?:\]|】)/g;
    let match;
    while ((match = regex.exec(String(answer || '')))) citations.push(Number(match[1]));
    return [...new Set(citations.filter(Number.isSafeInteger))];
}

function sourceEvidence(source) {
    const label = String(source?.label || '');
    const text = [label, source?.contextExcerpt, source?.excerpt].filter(Boolean).join('\n');
    return {
        index: Number(source?.index),
        text,
        normalized: normalizeEvidenceText(text),
        articleKeys: extractArticleKeys(text),
        documentTitle: label.split('/')[0].trim()
    };
}

function isReferenceGrounded(reference, evidence) {
    const normalizedLawName = normalizeLawName(reference.lawName);
    return evidence.some(source => {
        const sourceLawName = normalizeLawName(source.documentTitle);
        const lawMatches = !normalizedLawName
            || source.normalized.includes(normalizedLawName)
            || sourceLawName.includes(normalizedLawName)
            || (sourceLawName && normalizedLawName.includes(sourceLawName));
        const articleMatches = !reference.articleKey || source.articleKeys.includes(reference.articleKey);
        return lawMatches && articleMatches;
    });
}

function needsClarification(question) {
    const text = String(question || '').trim();
    return text.length < 12 || !/[？?。；;：:]/.test(text);
}

function buildInsufficientEvidenceAnswer({ question, sources, reason }) {
    const directCount = sources.filter(source => !source?.viaLink).length;
    const relatedCount = Math.max(0, sources.length - directCount);
    const candidateSummary = sources.length
        ? `本次检索得到 ${directCount} 条直接检索候选${relatedCount ? `和 ${relatedCount} 条引用关联候选` : ''}，但这些候选未能形成可核验、可直接适用于该问题的依据。`
        : '本次检索未返回可用的条文候选。';
    const detailRequest = needsClarification(question)
        ? '请补充具体罪名或业务事项、行为与情节、主体身份/年龄、发生时间及希望确认的法律问题。'
        : '请补充与候选条文的对应事实、适用范围和需要确认的具体法律问题。';
    return [
        '【核心法条】',
        candidateSummary,
        '',
        '【关联法条】',
        '当前没有已通过引用核验、可作为本问题直接依据的关联条文。',
        '',
        '【适用建议】',
        `${detailRequest}${reason ? ' 本回答已停止引用未在本轮候选中出现的法条。' : ''}`
    ].join('\n');
}

function validateRegulationAiGrounding({ answer, sources = [], question = '' } = {}) {
    const text = String(answer || '').trim();
    const list = (Array.isArray(sources) ? sources : []).filter(source => Number.isSafeInteger(Number(source?.index)) && Number(source.index) > 0);
    const evidence = list.map(sourceEvidence);
    const validIndexes = new Set(evidence.map(source => source.index));
    const citationIndexes = extractSourceCitations(text);
    const invalidCitations = citationIndexes.filter(index => !validIndexes.has(index));
    const legalReferences = extractLegalReferences(text);
    const ungroundedReferences = legalReferences.filter(reference => !isReferenceGrounded(reference, evidence)).map(reference => reference.raw);
    const reasons = [];
    if (!list.length) reasons.push('no_candidates');
    if (list.length && !citationIndexes.length) reasons.push('missing_source_citation');
    if (invalidCitations.length) reasons.push('invalid_source_citation');
    if (ungroundedReferences.length) reasons.push('ungrounded_legal_reference');
    const accepted = reasons.length === 0 && !!text;
    const status = accepted ? 'verified' : (list.length ? 'insufficient_evidence' : 'no_candidates');
    const grounding = {
        status,
        accepted,
        reasonCodes: reasons,
        citedSourceIndexes: citationIndexes.filter(index => validIndexes.has(index)),
        invalidCitations,
        ungroundedReferences: [...new Set(ungroundedReferences)].slice(0, 12),
        candidateCount: list.length,
        directCandidateCount: list.filter(source => !source?.viaLink).length
    };
    return {
        answer: accepted ? text : buildInsufficientEvidenceAnswer({ question, sources: list, reason: reasons.length > 0 }),
        grounding
    };
}

module.exports = {
    buildInsufficientEvidenceAnswer,
    extractLegalReferences,
    extractSourceCitations,
    normalizeArticleKey,
    validateRegulationAiGrounding
};
