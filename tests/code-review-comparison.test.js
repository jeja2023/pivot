'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareCodeReviewRuns } = require('../scripts/lib/code_review_comparison');
const digest = character => 'sha256:' + character.repeat(64);
function record() {
    const arm = (id, tokens, instructionDigest) => ({
        contextDigest: digest('a'), modelConfigDigest: digest('b'), instructionDigest,
        detail: { run: { id, model_id: 3, goal: '核对零值图表', status: 'completed', input_tokens: tokens - 10, output_tokens: 10, total_tokens: tokens, started_at: '2026-11-08T10:00:00+08:00', completed_at: '2026-11-08T10:00:03+08:00' }, steps: [{ type: 'tool' }] },
        quality: { passed: true, regressions: 0, evidence: '盲审记录及确定性回归断言' }
    });
    return { schemaVersion: 1, evidenceType: 'fixture', pairs: [{ caseId: 'zero', repeat: 1, baseline: arm('baseline', 200, digest('c')), candidate: arm('candidate', 120, digest('d')) }] };
}

test('对照汇总区分夹具与实测，并保留失败、零基数和质量退化', () => {
    const data = record();
    let report = compareCodeReviewRuns(data).models[0];
    assert.equal(report.delta.totalTokens.percent, -40);
    assert.equal(report.eligibleForPilot, false);
    data.evidenceType = 'measured';
    assert.equal(compareCodeReviewRuns(data).models[0].eligibleForPilot, true);
    data.pairs[0].candidate.detail.run.status = 'error';
    report = compareCodeReviewRuns(data).models[0];
    assert.equal(report.candidate.passed, 0);
    assert.equal(report.qualityNonDecreasing, false);
    assert.equal(report.eligibleForPilot, false);
    data.pairs[0].candidate.quality.regressions = 1;
    data.pairs[0].baseline.detail.steps = [];
    report = compareCodeReviewRuns(data).models[0];
    assert.equal(report.delta.toolCalls.percent, null);
    assert.equal(report.candidate.regressions, 1);
});

test('对照拒绝缺失指标、不同条件、重复运行及不完整证据', () => {
    const changes = [
        value => { delete value.pairs[0].candidate.detail.run.total_tokens; },
        value => { value.pairs[0].candidate.detail.run.total_tokens = false; },
        value => { value.pairs[0].candidate.detail.run.model_id = 9; },
        value => { value.pairs[0].candidate.contextDigest = digest('e'); },
        value => { value.pairs[0].candidate.instructionDigest = digest('c'); },
        value => { value.pairs[0].candidate.detail.run.id = 'baseline'; },
        value => { value.pairs[0].candidate.detail.run.status = 'running'; },
        value => { value.pairs[0].candidate.quality.evidence = ''; },
        value => { value.pairs[0].candidate.detail.warnings = ['步骤读取失败']; },
        value => { value.pairs.push(globalThis.structuredClone(value.pairs[0])); }
    ];
    for (const mutate of changes) { const data = record(); mutate(data); assert.throws(() => compareCodeReviewRuns(data), /无效/); }
});
