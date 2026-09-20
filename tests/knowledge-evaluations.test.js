'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    aggregateMetrics,
    computeAnswerPointCoverage,
    computeCitationMetrics,
    computeRetrievalMetrics
} = require('../server/services/knowledge-evaluations');

test('知识库评测计算 Recall、MRR、nDCG 与引用命中，不以候选总数冒充命中', () => {
    const metrics = computeRetrievalMetrics({
        expectedDocumentIds: [10],
        expectedChunkIds: [101],
        retrievedDocumentIds: [4, 10, 10],
        retrievedChunkIds: [40, 101, 102]
    });
    assert.equal(metrics.recallAt1, 0);
    assert.equal(metrics.recallAt3, 1);
    assert.equal(metrics.recallAt5, 1);
    assert.equal(metrics.firstRelevantRank, 2);
    assert.equal(metrics.mrr, 0.5);
    assert.ok(metrics.ndcgAt5 > 0 && metrics.ndcgAt5 < 1);
});

test('知识库评测对无答案问题单独评估拒答准确率', () => {
    const correctlyAbstained = computeRetrievalMetrics({ retrievedDocumentIds: [], retrievedChunkIds: [] });
    const falsePositive = computeRetrievalMetrics({ retrievedDocumentIds: [1], retrievedChunkIds: [9] });
    assert.equal(correctlyAbstained.hasExpected, false);
    assert.equal(correctlyAbstained.abstentionCorrect, true);
    assert.equal(falsePositive.abstentionCorrect, false);
    const summary = aggregateMetrics([
        { metrics: correctlyAbstained },
        { metrics: falsePositive },
        { metrics: { recallAt1: 1, recallAt3: 1, recallAt5: 1, precisionAt1: 1, precisionAt3: 1, precisionAt5: 1, mrr: 1, ndcgAt5: 1 } }
    ]);
    assert.equal(summary.abstentionAccuracy, 0.5);
    assert.equal(summary.recallAt1, 1);
});

test('知识库评测单独衡量引用精度召回与答案关键点覆盖，避免把空期望误计为满分', () => {
    assert.deepEqual(computeCitationMetrics({
        expectedCitationKeys: ['kb:1:v1:c10', 'kb:1:v1:c11'],
        citationKeys: ['kb:1:v1:c10', 'kb:9:v1:c99']
    }), {
        hasExpectedCitations: true,
        citationPrecision: 0.5,
        citationRecall: 0.5,
        citationF1: 0.5,
        matchedCitations: 1
    });
    assert.deepEqual(computeAnswerPointCoverage('审批需申请单和预算依据。', ['申请单', '预算依据', '风险评估']), {
        hasExpectedAnswerPoints: true,
        answerPointCoverage: 2 / 3,
        matchedAnswerPoints: 2
    });
    assert.equal(computeCitationMetrics({ citationKeys: ['kb:1'] }).citationPrecision, null);
    assert.equal(computeAnswerPointCoverage('任何回答', []).answerPointCoverage, null);
});
