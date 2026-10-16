'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { rejectLowConfidenceResults } = require('../server/services/rag-index/ranking');

test('明确罪名问题拒绝不包含罪名核心词的泛化候选', () => {
    const result = rejectLowConfidenceResults([{
        chunkId: 113,
        headingPath: '第一百一十三条',
        text: '危害国家安全罪情节特别严重的，可以判处死刑。',
        denseScore: 0.88,
        fused: 0.9,
        rerankScore: 0.9,
        citationConfidence: 0.8
    }], {
        scoreThreshold: 0.4,
        minRerankScore: 0.3,
        minCitationConfidence: 0.42,
        requiredTerms: ['抢劫罪', '抢劫']
    });
    assert.equal(result.rejected, true);
    assert.equal(result.reason, 'required_term_missing');
    assert.deepEqual(result.accepted, []);
});

test('包含罪名核心词的条文仍可通过后续可信度门控', () => {
    const result = rejectLowConfidenceResults([{
        chunkId: 263,
        headingPath: '第二百六十三条',
        text: '以暴力、胁迫或者其他方法抢劫公私财物的，处三年以上十年以下有期徒刑。',
        denseScore: 0.88,
        fused: 0.9,
        rerankScore: 0.9,
        citationConfidence: 0.8
    }], {
        scoreThreshold: 0.4,
        minRerankScore: 0.3,
        minCitationConfidence: 0.42,
        requiredTerms: ['抢劫罪', '抢劫']
    });
    assert.equal(result.rejected, false);
    assert.equal(result.accepted.length, 1);
});
