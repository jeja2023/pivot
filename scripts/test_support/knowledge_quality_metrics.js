'use strict';

function evaluateRetrievalSample(item, citations, topK = 5) {
    const retrieved = [...new Set(citations.map(citation => Number(citation.document?.id)).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, topK);
    const expected = [...new Set((item.expectedDocumentIds || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
    const rank = retrieved.findIndex(id => expected.includes(id));
    const citationLabels = item.expectedCitationKeys;
    return { hit: expected.length ? rank >= 0 : null,
        recallAtK: expected.length ? expected.filter(id => retrieved.includes(id)).length / expected.length : null,
        reciprocalRank: expected.length ? rank < 0 ? 0 : 1 / (rank + 1) : null,
        noAnswerCorrect: item.expectedNoAnswer === true ? citations.length === 0 : null,
        citationCorrect: Array.isArray(citationLabels) ? citations.map(citation => citationLabels.includes(citation.citationKey)) : [],
        doubleReviewed: Array.isArray(item.reviewers) && new Set(item.reviewers.filter(value => typeof value === 'string' && value.trim())).size >= 2 };
}

function aggregateRetrievalQuality(samples) {
    const successful = samples.filter(sample => !sample.error);
    const mean = key => { const values = successful.map(sample => sample[key]).filter(value => value !== null && value !== undefined); return { value: values.length ? values.reduce((sum, value) => sum + Number(value), 0) / values.length : null, samples: values.length }; };
    const citations = successful.flatMap(sample => sample.citationCorrect || []);
    return { recallAtK: mean('recallAtK'), mrr: mean('reciprocalRank'), noAnswerAccuracy: mean('noAnswerCorrect'),
        citationAccuracy: { value: citations.length ? citations.filter(Boolean).length / citations.length : null, samples: citations.length },
        doubleReviewedCases: successful.filter(sample => sample.doubleReviewed).length,
        factSupportRate: { value: null, samples: 0, reason: '需另行提供逐项事实支持标注，检索命中不能代替事实核验。' } };
}

module.exports = { aggregateRetrievalQuality, evaluateRetrievalSample };
