'use strict';

function normalizeForCer(value) {
    return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

function levenshtein(left, right) {
    const source = Array.from(left);
    const target = Array.from(right);
    let previous = Array.from({ length: target.length + 1 }, (_item, index) => index);
    for (let i = 1; i <= source.length; i += 1) {
        const current = [i];
        for (let j = 1; j <= target.length; j += 1) {
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (source[i - 1] === target[j - 1] ? 0 : 1));
        }
        previous = current;
    }
    return previous[target.length];
}

function characterErrorRate(expected, actual) {
    const reference = normalizeForCer(expected);
    const recognized = normalizeForCer(actual);
    if (!reference) return recognized ? 1 : 0;
    return levenshtein(reference, recognized) / Array.from(reference).length;
}

function fieldExactMatch(expected = {}, actual = {}) {
    const keys = Object.keys(expected);
    if (!keys.length) return { total: 0, matched: 0, rate: 1 };
    const matched = keys.filter(key => normalizeForCer(expected[key]) === normalizeForCer(actual[key])).length;
    return { total: keys.length, matched, rate: matched / keys.length };
}

function readingOrderAccuracy(expected = [], actual = []) {
    if (!expected.length) return 1;
    const positions = new Map(actual.map((id, index) => [String(id), index]));
    const ordered = expected.every((id, index) => index === 0 || positions.get(String(expected[index - 1])) < positions.get(String(id)));
    return ordered ? 1 : 0;
}

function evaluateGoldenCase({ expected = {}, actual = {} } = {}) {
    const cer = characterErrorRate(expected.text, actual.text);
    const fields = fieldExactMatch(expected.fields, actual.fields);
    const order = readingOrderAccuracy(expected.readingOrder, actual.readingOrder);
    return { cer, fields, readingOrderAccuracy: order, pass: cer <= Number(expected.maxCer ?? 0.03) && fields.rate === 1 && order === 1 };
}

function summarizeGoldenResults(results = []) {
    const safe = Array.isArray(results) ? results : [];
    return {
        cases: safe.length,
        passed: safe.filter(item => item.pass).length,
        averageCer: safe.length ? safe.reduce((sum, item) => sum + Number(item.cer || 0), 0) / safe.length : 0,
        fieldExactRate: safe.length ? safe.reduce((sum, item) => sum + Number(item.fields?.rate || 0), 0) / safe.length : 1,
        readingOrderAccuracy: safe.length ? safe.reduce((sum, item) => sum + Number(item.readingOrderAccuracy || 0), 0) / safe.length : 1
    };
}

module.exports = { characterErrorRate, evaluateGoldenCase, summarizeGoldenResults };
