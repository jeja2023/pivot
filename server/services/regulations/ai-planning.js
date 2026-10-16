'use strict';

const { normalizeRegulationId } = require('./shared');
const { readTypedEnv } = require('../../config/env-registry');

const MAX_AI_QUERY_VARIANTS = 3;
const MAX_SELECTED_ARTICLES = 24;

function regulationAiLimits(env = process.env) {
    return {
        candidateLimit: readTypedEnv('REGULATION_AI_CANDIDATE_LIMIT', env),
        evidenceLimit: readTypedEnv('REGULATION_AI_EVIDENCE_LIMIT', env),
        relatedLimit: readTypedEnv('REGULATION_AI_RELATED_LIMIT', env),
        maxOutputTokens: readTypedEnv('REGULATION_AI_MAX_OUTPUT_TOKENS', env)
    };
}

function uniqueText(values, maximum = MAX_AI_QUERY_VARIANTS) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        const key = text.toLocaleLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        result.push(text);
        if (result.length >= maximum) break;
    }
    return result;
}

function normalizeArticleIds(value, maximum = MAX_SELECTED_ARTICLES) {
    const source = Array.isArray(value) ? value : (value === undefined || value === null || value === '' ? [] : [value]);
    return [...new Set(source.map(normalizeRegulationId).filter(Boolean))].slice(0, maximum);
}

function extractArticleReference(question) {
    const match = String(question || '').match(/第\s*([零〇一二两三四五六七八九十百千万\d]+)\s*条(?:\s*之\s*([零〇一二两三四五六七八九十百千万\d]+))?/);
    if (!match) return '';
    return `第${match[1]}条${match[2] ? `之${match[2]}` : ''}`;
}

function extractNamedRegulation(question) {
    const match = String(question || '').match(/《([^》\n]{2,100})》/);
    return match ? `《${match[1].trim()}》` : '';
}

function extractEffectiveDate(question) {
    const text = String(question || '');
    const iso = text.match(/((?:19|20)\d{2})[-/.年](0?[1-9]|1[0-2])[-/.月](0?[1-9]|[12]\d|3[01])日?/);
    if (!iso) return '';
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function extractSearchAnchor(question) {
    return String(question || '')
        .replace(/《[^》]+》/g, ' ')
        .replace(/第\s*[零〇一二两三四五六七八九十百千万\d]+\s*条(?:\s*之\s*[零〇一二两三四五六七八九十百千万\d]+)?/g, ' ')
        .replace(/[？?。！!；;：:,，、（）()【】\[\]“”"'`]/g, ' ')
        .replace(/(?:请问|请|是否|能否|如何|哪些|什么|关于|对于|这个|那条|本条|该条|其中|规定|要求|问题)/g, ' ')
        .replace(/(?:最高|最低|可以|可能|应当|判处|多少|几年|多长|有期徒刑)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
}

function isLikelyFollowUp(question) {
    const text = String(question || '').replace(/\s+/g, '').trim();
    if (!text) return false;
    return text.length <= 18 || /^(那|这|该|其|本)(个|条|项|规定|情形|期限|标准|责任|处罚|流程|怎么|如何|是否)/.test(text);
}

function previousQuestion(history = []) {
    const turns = Array.isArray(history) ? history : [];
    for (let index = turns.length - 1; index >= 0; index -= 1) {
        const question = String(turns[index]?.question || '').trim();
        if (question) return question;
    }
    return '';
}

// 规则规划只负责补全可检索锚点，不代替模型作法律判断；这样短追问也不会脱离上一轮对象。
function buildRegulationAiQueryPlan({ question = '', history = [], effectiveAt = '' } = {}) {
    const normalizedQuestion = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    const articleReference = extractArticleReference(normalizedQuestion);
    const namedRegulation = extractNamedRegulation(normalizedQuestion);
    const historicalQuestion = isLikelyFollowUp(normalizedQuestion) ? previousQuestion(history) : '';
    const anchor = extractSearchAnchor(normalizedQuestion);
    const crimeTerm = normalizedQuestion.match(/([\u3400-\u9fff]{2,6}罪)/u)?.[1]
        ?.replace(/^(?:触犯|涉嫌|构成|犯了|关于|对于|在|犯)/u, '') || '';
    const historicalAnchor = extractSearchAnchor(historicalQuestion);
    const queries = uniqueText([
        normalizedQuestion,
        [namedRegulation, articleReference].filter(Boolean).join(' '),
        crimeTerm ? crimeTerm.slice(0, -1) : '',
        crimeTerm,
        anchor,
        [historicalAnchor, anchor].filter(Boolean).join(' ')
    ]);
    return {
        question: normalizedQuestion,
        retrievalQueries: queries.length ? queries : [normalizedQuestion],
        articleReference,
        namedRegulation,
        effectiveAt: String(effectiveAt || '').trim() || extractEffectiveDate(normalizedQuestion),
        followUpResolved: Boolean(historicalQuestion),
        historicalQuestion: historicalQuestion.slice(0, 500)
    };
}

module.exports = {
    buildRegulationAiQueryPlan,
    normalizeArticleIds,
    regulationAiLimits
};
