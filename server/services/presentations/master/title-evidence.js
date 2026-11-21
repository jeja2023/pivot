'use strict';

const { compact, containsValue } = require('./citation-repair');

// 保留原句核对指标及单位。年份、日期、季度和章节编号本身不构成业务数字。
function quantitativeClauses(title) {
    const normalized = String(title || '').normalize('NFKC');
    const clauses = normalized.split(/[。；;！？!?\n]|,(?!\d{3}(?:\D|$))/u).map(s => s.trim());
    const claims = clauses.filter(clause => {
        const body = clause.replace(/(?:19|20)\d{2}\s*[-–—至/]\s*(?:19|20)\d{2}(?:\s*年)?(?![\d%万亿元])/gu, '')
            .replace(/(?<!\d)(?:19|20)\d{2}(?:\s*年(?:度|\d{1,2}月(?:\d{1,2}日)?)?|[-/]\d{1,2}(?:[-/]\d{1,2})?|(?=Q[1-4]))/giu, '')
            .replace(/第\s*[\d一二三四五六七八九十]+\s*(?:页|章|节|季|部分)|\bQ[1-4]\b/giu, '')
            .replace(/^\s*(?:FY\s*)?(?:19|20)\d{2}(?=\s|$)/iu, '')
            .replace(/\(\s*(?:19|20)\d{2}\s*\)|(?:财年|年度|年报)\s*(?:19|20)\d{2}(?!\d)/gu, '')
            .replace(/^\s*\d+[.、)）]\s*(?=\p{L})/u, '')
            .replace(/^(?:经营回顾|标题|章节|附录|方案|案例|页面|图|表|slide|page|appendix)\s*[-#]?\s*\d+$/iu, '');
        if (/\p{Nd}/u.test(body)) return true;
        return /(?:[¥￥$€£]|百分之|千分之)\s*[\d零〇一二两三四五六七八九十百千万亿]|[\d零〇一二两三四五六七八九十百千万亿]\s*(?:[%‰]|个?百分点|[百千万元亿]*元|美元|人民币|[人件台吨家倍项笔]|万元|亿元|万亿|万|亿|USD\b|million\b|billion\b)/iu.test(body)
            || /(?:增长|下降|增加|减少|提高|降低|达到|增至|降至|营收|收入|成本|利润|销量|预算|占比|同比|环比|revenue|profit|sales|growth|cost)\s*[^，。；]{0,10}?[\d零〇一二两三四五六七八九十百千万亿]/iu.test(body);
    });
    // 单独的数值或省略指标的后半句须连同前文核证，避免把另一个指标的相同数值当作依据。
    if (clauses.length > 1 && claims.some(claim => /^(?:[-+\d¥￥$€£]|同比|环比|增长|下降|增加|提高|达到|减少|为)/u.test(claim)
        && claim !== clauses[0])) return [normalized];
    return claims;
}

function missingTitleClaims(page) {
    return quantitativeClauses(page.title).filter(claim => ![page.titleSource, ...(page.values || []).map(value => value.source)]
        .some(source => typeof source?.quote === 'string' && containsValue(compact(source.quote), claim)));
}

module.exports = { missingTitleClaims };
