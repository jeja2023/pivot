'use strict';

/*
 * 确定性的记忆评测辅助函数。仅评估检索集合而不评判生成答案，因此每次
 * CI 运行都可复现，也无需把私有测试对话发送给裁判模型。
 */
function uniqueIds(values = []) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(value => Number.parseInt(value, 10))
        .filter(value => Number.isSafeInteger(value) && value > 0))];
}

function normalizeCase(value = {}) {
    return {
        id: String(value.id || '').trim(),
        category: String(value.category || 'general').trim(),
        query: String(value.query || '').trim(),
        expectedMemoryIds: uniqueIds(value.expectedMemoryIds || value.expected_memory_ids),
        forbiddenMemoryIds: uniqueIds(value.forbiddenMemoryIds || value.forbidden_memory_ids),
        expectsNoMemory: value.expectsNoMemory === true,
        tags: [...new Set((Array.isArray(value.tags) ? value.tags : []).map(String).filter(Boolean))]
    };
}

function evaluateMemoryRetrievalCase(rawCase, retrieved = []) {
    const evaluationCase = normalizeCase(rawCase);
    const actual = uniqueIds((Array.isArray(retrieved) ? retrieved : []).map(item => item?.id ?? item));
    const expected = new Set(evaluationCase.expectedMemoryIds);
    const forbidden = new Set(evaluationCase.forbiddenMemoryIds);
    const matched = actual.filter(id => expected.has(id));
    const forbiddenHits = actual.filter(id => forbidden.has(id));
    const expectedCount = expected.size;
    const irrelevant = actual.filter(id => !expected.has(id));
    const firstRank = actual.findIndex(id => expected.has(id));
    const recallAt = limit => expectedCount ? matched.filter(id => actual.indexOf(id) < limit).length / expectedCount : null;
    const precisionAt = limit => {
        const slice = actual.slice(0, limit);
        return slice.length ? slice.filter(id => expected.has(id)).length / slice.length : null;
    };
    const noMemoryCorrect = evaluationCase.expectsNoMemory ? actual.length === 0 : null;
    return {
        id: evaluationCase.id,
        category: evaluationCase.category,
        retrievedIds: actual,
        expectedIds: evaluationCase.expectedMemoryIds,
        matchedIds: matched,
        forbiddenHits,
        recallAt1: recallAt(1),
        recallAt3: recallAt(3),
        recallAt8: recallAt(8),
        precisionAt1: precisionAt(1),
        precisionAt3: precisionAt(3),
        precisionAt8: precisionAt(8),
        mrr: expectedCount ? (firstRank === -1 ? 0 : 1 / (firstRank + 1)) : null,
        irrelevantRate: actual.length ? irrelevant.length / actual.length : 0,
        noMemoryCorrect,
        passed: evaluationCase.expectsNoMemory
            ? noMemoryCorrect === true && forbiddenHits.length === 0
            : matched.length > 0 && forbiddenHits.length === 0
    };
}

function average(values = []) {
    const usable = values.filter(value => value !== null && value !== undefined && Number.isFinite(Number(value))).map(Number);
    return usable.length ? Number((usable.reduce((sum, value) => sum + value, 0) / usable.length).toFixed(4)) : null;
}

function summarizeMemoryEvaluation(results = []) {
    const records = Array.isArray(results) ? results : [];
    const noMemory = records.filter(result => result.noMemoryCorrect !== null);
    return {
        cases: records.length,
        passed: records.filter(result => result.passed).length,
        failed: records.filter(result => !result.passed).length,
        passRate: records.length ? Number((records.filter(result => result.passed).length / records.length).toFixed(4)) : null,
        recallAt1: average(records.map(result => result.recallAt1)),
        recallAt3: average(records.map(result => result.recallAt3)),
        recallAt8: average(records.map(result => result.recallAt8)),
        precisionAt8: average(records.map(result => result.precisionAt8)),
        mrr: average(records.map(result => result.mrr)),
        irrelevantRate: average(records.map(result => result.irrelevantRate)),
        forbiddenHitRate: records.length ? Number((records.filter(result => result.forbiddenHits.length > 0).length / records.length).toFixed(4)) : null,
        noMemoryAccuracy: noMemory.length ? Number((noMemory.filter(result => result.noMemoryCorrect).length / noMemory.length).toFixed(4)) : null
    };
}

function compareMemoryRetrievalShadow(rawCase, legacyRetrieved, candidateRetrieved) {
    const legacy = evaluateMemoryRetrievalCase(rawCase, legacyRetrieved);
    const candidate = evaluateMemoryRetrievalCase(rawCase, candidateRetrieved);
    return {
        id: candidate.id,
        legacy,
        candidate,
        recallDelta: (candidate.recallAt8 ?? 0) - (legacy.recallAt8 ?? 0),
        irrelevantDelta: candidate.irrelevantRate - legacy.irrelevantRate,
        forbiddenRegression: candidate.forbiddenHits.length > legacy.forbiddenHits.length,
        improved: candidate.passed && !legacy.passed
    };
}

module.exports = {
    compareMemoryRetrievalShadow,
    evaluateMemoryRetrievalCase,
    summarizeMemoryEvaluation
};
