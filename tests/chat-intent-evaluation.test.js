'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateChatIntentCase, summarizeChatIntentEvaluation } = require('../scripts/lib/chat_intent_evaluation');

test('模型失败后的兜底澄清不得作为正确语义判断计分', () => {
    const item = { expected: ['clarify'] };
    for (const decision of [
        { action: 'clarify', capabilityDecisionUnavailable: true },
        { action: 'clarify', reasonCode: 'decision_unavailable' },
        { action: 'clarify', failureCode: 'intent_timeout' },
        { action: 'clarify', shadow: true }
    ]) assert.equal(evaluateChatIntentCase(item, decision).passed, false);
    assert.equal(evaluateChatIntentCase(item, { action: 'clarify', reasonCode: 'semantic_intent' }).passed, true);
});

test('动作相同仍检查检索问题、来源、能力、续接对象和验收要求', () => {
    const item = { expected: ['continue_run'], expectedContinuationOf: 'owned', expectedQueryIncludes: ['实习生', '婚假'],
        expectedRouting: { knowledge: 'required' }, expectedCapabilities: ['knowledge.search'], expectedAcceptance: { requireEvidence: true }, expectedConstraintIncludes: ['只读'] };
    const decision = { action: 'continue_run', continuationOf: 'owned', routing: { knowledge: 'required', retrievalQuery: '实习生婚假规则' },
        requiredCapabilities: ['knowledge.search'], acceptance: { requireEvidence: true }, constraints: ['只读查询'] };
    assert.equal(evaluateChatIntentCase(item, decision).passed, true);
    for (const changed of [{ continuationOf: 'wrong' }, { acceptance: {} }, { requiredCapabilities: [] }, { constraints: [] }, { routing: { knowledge: 'required', retrievalQuery: '那他们呢？' } }]) {
        assert.equal(evaluateChatIntentCase(item, { ...decision, ...changed }).passed, false);
    }
    const report = summarizeChatIntentEvaluation([{ ...evaluateChatIntentCase(item, decision), critical: true, baselinePassed: false, durationMs: 5 },
        { ...evaluateChatIntentCase(item, { action: 'clarify', failureCode: 'intent_timeout' }), critical: true, durationMs: 30 }]);
    assert.equal(report.passed, 1);
    assert.equal(report.criticalFailures, 1);
    assert.equal(report.unavailable, 1);
    assert.equal(report.p95Ms, 30);
});
