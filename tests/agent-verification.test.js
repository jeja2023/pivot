'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeTaskContract, verifyTaskOutcome } = require('../server/services/agent-verification');

test('task contract always adds a hard non-empty final-answer verification', () => {
    const contract = normalizeTaskContract({}, '整理项目风险');
    assert.equal(contract.revision, 1);
    const report = verifyTaskOutcome({ taskContract: contract, answer: '' });
    assert.equal(report.outcomeStatus, 'needs_input');
    assert.deepEqual(report.hardFailures, ['final_answer_non_empty']);
});

test('task contract retains a bounded revision for runtime constraint changes', () => {
    const contract = normalizeTaskContract({ revision: 4, constraints: ['仅使用已授权资料'] }, '生成周报');
    assert.equal(contract.revision, 4);
    assert.deepEqual(contract.constraints, ['仅使用已授权资料']);
});

test('task verification blocks forbidden content and missing required artifacts', () => {
    const report = verifyTaskOutcome({
        taskContract: {
            acceptance: {
                forbiddenPhrases: ['未经批准'],
                requiredArtifacts: ['风险周报.docx']
            }
        },
        answer: '报告未经批准发送。',
        observations: [{ output: { file: { id: 'f1', name: '其他文件.docx' } } }]
    });
    assert.equal(report.outcomeStatus, 'needs_input');
    assert.deepEqual(report.hardFailures.sort(), ['forbidden_phrase', 'required_artifact']);
});

test('task verification records partial outcomes separately from verified completion', () => {
    const report = verifyTaskOutcome({ answer: '已完成部分结果。', partial: true, reason: '预算耗尽' });
    assert.equal(report.outcomeStatus, 'partial');
    assert.equal(report.hardFailures.length, 0);
});

test('task verification accepts a persisted evidence reference for evidence-required work', () => {
    const withoutEvidence = verifyTaskOutcome({ taskContract: { acceptance: { requireEvidence: true } }, answer: '结论' });
    assert.equal(withoutEvidence.outcomeStatus, 'needs_input');
    const withEvidence = verifyTaskOutcome({ taskContract: { acceptance: { requireEvidence: true } }, answer: '结论', evidence: [{ id: 'e1' }] });
    assert.equal(withEvidence.outcomeStatus, 'verified');
});
