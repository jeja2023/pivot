'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    assessJudgeCalibration,
    consensusByEvaluationResult,
    consensusForJudgeResults,
    normalizeProfileInput,
    parseJudgeJson,
    safeJudgePayload
} = require('../server/services/agent-judge-governance');

test('judge profile freezes a bounded reproducible rubric and runtime configuration', () => {
    const profile = normalizeProfileInput({
        name: '交付质量双裁判', modelId: 9, promptVersion: 'v2', status: 'active',
        rubric: { criteria: ['事实有来源', '满足任务约束'], hardRules: ['不得泄露密钥'] },
        config: { temperature: 3, maxTokens: 99999, maxInputChars: 999999, confidenceThreshold: 0.85 }
    });
    assert.equal(profile.modelId, 9);
    assert.equal(profile.status, 'active');
    assert.equal(profile.config.temperature, 1);
    assert.equal(profile.config.maxTokens, 4096);
    assert.equal(profile.config.maxInputChars, 24000);
    assert.equal(profile.rubric.hardRules[0], '不得泄露密钥');
});

test('judge output schema rejects ambiguous values and parses only the narrow verdict contract', () => {
    const verdict = parseJudgeJson('```json\n{"decision":"fail","score":12,"confidence":0.91,"reasons":["没有来源"],"hardFailures":["evidence"]}\n```');
    assert.deepEqual(verdict, { decision: 'fail', score: 12, confidence: 0.91, reasons: ['没有来源'], hardFailures: ['evidence'] });
    assert.throws(() => parseJudgeJson('{"decision":"approve"}'), error => error.code === 'AGENT_JUDGE_OUTPUT_INVALID');
});

test('judge disagreement, low confidence, and hard failures are held for human review per evaluation result', () => {
    const profiles = new Map([
        ['a', { config: { scoreDisagreement: 10, confidenceThreshold: 0.8 } }],
        ['b', { config: { scoreDisagreement: 10, confidenceThreshold: 0.8 } }]
    ]);
    const disagreement = consensusForJudgeResults([
        { judgeProfileId: 'a', status: 'completed', decision: 'pass', score: 90, confidence: 0.9, verdict: { hardFailures: [] } },
        { judgeProfileId: 'b', status: 'completed', decision: 'fail', score: 20, confidence: 0.9, verdict: { hardFailures: [] } }
    ], profiles);
    assert.equal(disagreement.requiresHumanReview, true);
    assert.equal(disagreement.reason, 'judge_decision_disagreement');

    const grouped = consensusByEvaluationResult([
        { evalResultId: 1, judgeProfileId: 'a', status: 'completed', decision: 'pass', score: 90, confidence: 0.9, verdict: { hardFailures: [] } },
        { evalResultId: 1, judgeProfileId: 'b', status: 'completed', decision: 'pass', score: 89, confidence: 0.9, verdict: { hardFailures: [] } },
        { evalResultId: 2, judgeProfileId: 'a', status: 'completed', decision: 'pass', score: 90, confidence: 0.7, verdict: { hardFailures: [] } },
        { evalResultId: 2, judgeProfileId: 'b', status: 'completed', decision: 'pass', score: 91, confidence: 0.9, verdict: { hardFailures: [] } }
    ], profiles);
    assert.equal(grouped.find(item => item.evalResultId === 1).decision, 'pass');
    assert.equal(grouped.find(item => item.evalResultId === 2).requiresHumanReview, true);

    const reviewed = consensusForJudgeResults([
        { judgeProfileId: 'a', status: 'completed', decision: 'pass', score: 90, confidence: 0.9, verdict: { hardFailures: [] }, humanDecision: 'fail' },
        { judgeProfileId: 'b', status: 'completed', decision: 'fail', score: 20, confidence: 0.9, verdict: { hardFailures: [] } }
    ], profiles);
    assert.equal(reviewed.decision, 'fail');
    assert.equal(reviewed.reason, 'human_review_override');
});

test('judge payload is bounded and digested before it crosses a model boundary', () => {
    const longOutput = 'A'.repeat(50000);
    const payload = safeJudgePayload({
        case_snapshot: { name: 'test', input: 'input', expectedOutput: 'expected', assertions: { evaluationTier: 'scenario' } },
        actual_output: longOutput
    }, { config: { maxInputChars: 4000 } });
    assert.equal(payload.digest.length, 64);
    assert.ok(payload.payload.candidateOutput.length <= 2200);
});

test('judge calibration retires a profile only after enough human-reviewed evidence shows unsafe agreement', () => {
    const rows = Array.from({ length: 20 }, (_value, index) => ({
        judgeDecision: 'pass', humanDecision: index === 0 ? 'fail' : 'pass'
    }));
    const calibration = assessJudgeCalibration(rows);
    assert.equal(calibration.eligible, true);
    assert.equal(calibration.falseAccept, 1);
    assert.equal(calibration.shouldRetire, true);

    const insufficient = assessJudgeCalibration(rows.slice(0, 19));
    assert.equal(insufficient.eligible, false);
    assert.equal(insufficient.shouldRetire, false);
});
