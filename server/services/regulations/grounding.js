'use strict';

const CHINESE_DIGITS = new Map([
    ['零', 0], ['〇', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4],
    ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9]
]);
const CHINESE_UNITS = new Map([['十', 10], ['百', 100], ['千', 1000], ['万', 10000]]);

function normalizeEvidenceText(value) {
    return String(value || '')
        .toLocaleLowerCase()
        .replace(/[\s\u3000，。；、：“”‘’（）()【】\[\]《》〈〉<>「」『』!！?？,.;:]/g, '');
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
        references.push({ lawName: String(match[1] || '').trim(), articleKey: normalizeArticleKey(match[2] || ''), raw: match[0] });
    }
    for (const articleKey of extractArticleKeys(text)) {
        if (!references.some(item => item.articleKey === articleKey)) references.push({ lawName: '', articleKey, raw: articleKey });
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

function buildEvidenceUnavailableAnswer({ question, sources, reasonCodes = [] }) {
    const directCount = sources.filter(source => !source?.viaLink).length;
    const relatedCount = Math.max(0, sources.length - directCount);
    const hasCandidates = sources.length > 0;
    const formatOnly = reasonCodes.length > 0 && reasonCodes.every(code => code === 'missing_source_citation' || code === 'invalid_structured_output');
    const reason = !hasCandidates
        ? '本次检索未返回可用的条文候选。'
        : formatOnly
            ? `本次已检索到 ${directCount} 条直接检索候选${relatedCount ? `和 ${relatedCount} 条已核验关联候选` : ''}，但模型未按可核验引用格式返回结论。`
            : `本次检索得到 ${directCount} 条直接检索候选${relatedCount ? `和 ${relatedCount} 条已核验关联候选` : ''}，但这些候选尚不足以支持具体法律结论。`;
    const detailRequest = needsClarification(question)
        ? '请补充具体罪名或业务事项、行为与情节、主体身份/年龄、发生时间及希望确认的法律问题。'
        : '请补充与候选条文的对应事实、适用范围和需要确认的具体法律问题。';
    return [
        '【核心法条】', reason, '',
        '【关联法条】', '当前没有可作为本问题直接结论依据的已核验关联条文。', '',
        '【适用建议】', `${detailRequest} 您也可以在下方保留最相关候选后重新生成。`
    ].join('\n');
}

function parseStructuredAnswer(answer) {
    const raw = String(answer || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    if (!raw.startsWith('{')) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_error) {
        return null;
    }
}

function normalizeClaimSourceIds(value) {
    const source = Array.isArray(value) ? value : [value];
    return [...new Set(source.map(item => Number.parseInt(item, 10)).filter(item => Number.isSafeInteger(item) && item > 0))].slice(0, 8);
}

function validateStructuredAnswer(structured, evidence) {
    const validIndexes = new Set(evidence.map(source => source.index));
    const answerability = String(structured.answerability || '').trim().toLowerCase();
    const claims = Array.isArray(structured.claims) ? structured.claims.slice(0, 12) : [];
    const clarification = answerability === 'clarification';
    if (!claims.length && !clarification) return { accepted: false, reasonCodes: ['invalid_structured_output'] };
    const verifiedClaims = [];
    const invalidClaims = [];
    for (const rawClaim of claims) {
        const text = String(rawClaim?.text || rawClaim?.claim || '').trim().slice(0, 1600);
        const sourceIds = normalizeClaimSourceIds(rawClaim?.sourceIds ?? rawClaim?.source_ids ?? rawClaim?.sources);
        const quote = String(rawClaim?.quote || '').trim().slice(0, 500);
        const selectedEvidence = evidence.filter(source => sourceIds.includes(source.index));
        const quoteGrounded = quote.length >= 8 && selectedEvidence.some(source => source.normalized.includes(normalizeEvidenceText(quote)));
        if (!text || !sourceIds.length || sourceIds.some(id => !validIndexes.has(id)) || !quoteGrounded) {
            invalidClaims.push({ text, sourceIds, hasQuote: Boolean(quote) });
            continue;
        }
        verifiedClaims.push({ text, sourceIds, quote });
    }
    if (invalidClaims.length || (!verifiedClaims.length && !clarification)) return { accepted: false, reasonCodes: ['claim_not_grounded'], invalidClaims };
    const answerText = String(structured.answer || structured.summary || '').trim().slice(0, 4000);
    const unsupportedAdvice = extractLegalReferences(answerText).filter(reference => !isReferenceGrounded(reference, evidence));
    if (unsupportedAdvice.length) {
        return {
            accepted: false,
            reasonCodes: ['claim_not_grounded'],
            invalidClaims: unsupportedAdvice.map(reference => ({ text: reference.raw, sourceIds: [], hasQuote: false }))
        };
    }
    const answer = clarification
        ? ['【核心法条】', '当前候选不足以形成可直接适用的结论。', '', '【关联法条】', '无。', '', '【适用建议】', answerText || String(structured.clarification || '请补充主体、行为、时间和具体事项后重新检索。').trim()].join('\n')
        : ['【核心法条】', ...verifiedClaims.map(claim => `${claim.text}。${claim.sourceIds.map(id => `[${id}]`).join('')}`), '', '【关联法条】', '无已核验关联条文时不作为结论依据。', '', '【适用建议】', answerText || '请结合具体事实逐项核对上述条文的适用条件。'].join('\n');
    return { accepted: true, answer, verifiedClaims, answerability: clarification ? 'clarification' : 'adequate' };
}

function validateRegulationAiGrounding({ answer, sources = [], question = '' } = {}) {
    const text = String(answer || '').trim();
    const list = (Array.isArray(sources) ? sources : []).filter(source => Number.isSafeInteger(Number(source?.index)) && Number(source.index) > 0);
    const evidence = list.map(sourceEvidence);
    const validIndexes = new Set(evidence.map(source => source.index));
    const structured = parseStructuredAnswer(text);
    if (!list.length) {
        const grounding = { status: 'no_candidates', accepted: false, reasonCodes: ['no_candidates'], candidateCount: 0, directCandidateCount: 0, format: structured ? 'structured' : 'legacy' };
        return { answer: buildEvidenceUnavailableAnswer({ question, sources: list, reasonCodes: grounding.reasonCodes }), grounding };
    }
    if (structured) {
        const result = validateStructuredAnswer(structured, evidence);
        if (result.accepted) {
            const citedSourceIndexes = [...new Set(result.verifiedClaims.flatMap(claim => claim.sourceIds))];
            return {
                answer: result.answer,
                grounding: {
                    status: result.answerability === 'clarification' ? 'clarification_needed' : 'verified',
                    accepted: true,
                    reasonCodes: [], citedSourceIndexes, invalidCitations: [], ungroundedReferences: [],
                    candidateCount: list.length, directCandidateCount: list.filter(source => !source?.viaLink).length,
                    verifiedClaimCount: result.verifiedClaims.length, format: 'structured'
                }
            };
        }
        const grounding = {
            status: result.reasonCodes.includes('claim_not_grounded') ? 'candidate_conflict' : 'citation_repair_required',
            accepted: false, reasonCodes: result.reasonCodes, invalidClaims: result.invalidClaims || [],
            candidateCount: list.length, directCandidateCount: list.filter(source => !source?.viaLink).length, format: 'structured'
        };
        return { answer: buildEvidenceUnavailableAnswer({ question, sources: list, reasonCodes: grounding.reasonCodes }), grounding };
    }
    const citationIndexes = extractSourceCitations(text);
    const invalidCitations = citationIndexes.filter(index => !validIndexes.has(index));
    const legalReferences = extractLegalReferences(text);
    const ungroundedReferences = legalReferences.filter(reference => !isReferenceGrounded(reference, evidence)).map(reference => reference.raw);
    const reasons = [];
    if (!citationIndexes.length) reasons.push('missing_source_citation');
    if (invalidCitations.length) reasons.push('invalid_source_citation');
    if (ungroundedReferences.length) reasons.push('ungrounded_legal_reference');
    const accepted = reasons.length === 0 && !!text;
    const grounding = {
        status: accepted ? 'verified' : 'insufficient_evidence', accepted, reasonCodes: reasons,
        citedSourceIndexes: citationIndexes.filter(index => validIndexes.has(index)), invalidCitations,
        ungroundedReferences: [...new Set(ungroundedReferences)].slice(0, 12),
        candidateCount: list.length, directCandidateCount: list.filter(source => !source?.viaLink).length,
        format: 'legacy', repairable: reasons.length > 0 && reasons.every(code => code === 'missing_source_citation')
    };
    return { answer: accepted ? text : buildEvidenceUnavailableAnswer({ question, sources: list, reasonCodes: reasons }), grounding };
}

module.exports = {
    normalizeArticleKey,
    validateRegulationAiGrounding
};
