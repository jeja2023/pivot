'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assessEvaluationReleaseGate, requiresAdversarialCoverage } = require('../server/services/agent-evaluation-gates');
const { gradeAgentOutput } = require('../server/services/agent-evaluations');

function result({ id, tier, passed = true, smokeOnly = false, hardFailures = [] } = {}) {
    return {
        id,
        status: passed ? 'passed' : 'failed',
        passed,
        case_snapshot: { name: id, assertions: { evaluationTier: tier } },
        grader_results: { qualityEligible: !smokeOnly, smokeOnly, hardFailures }
    };
}

test('production evaluation gate requires frozen target version, real quality checks, and requested tier coverage', () => {
    const evaluation = {
        run: { id: 'eval-1', status: 'completed', target_snapshot: { workflowVersionId: 9 }, summary: { passRate: 100 } },
        results: [
            result({ id: 'contract', tier: 'contract' }),
            result({ id: 'scenario', tier: 'scenario' }),
            result({ id: 'adversarial', tier: 'adversarial' })
        ]
    };
    const gate = assessEvaluationReleaseGate(evaluation, {
        targetVersionId: 9, minCases: 3, requiredTiers: ['contract', 'scenario'], requireAdversarial: true
    });
    assert.equal(gate.passed, true);
    assert.deepEqual(gate.evidence.coveredTiers, ['adversarial', 'contract', 'scenario']);
});

test('production evaluation gate rejects smoke-only evidence, hard failures, omitted adversarial coverage, and stale versions', () => {
    const gate = assessEvaluationReleaseGate({
        run: { id: 'eval-2', status: 'completed', target_snapshot: { workflowVersionId: 8 }, summary: { passRate: 100 } },
        results: [
            result({ id: 'contract', tier: 'contract', smokeOnly: true }),
            result({ id: 'scenario', tier: 'scenario', hardFailures: ['forbidden_phrase'] })
        ]
    }, {
        targetVersionId: 9, minCases: 3, requiredTiers: ['contract', 'scenario'], requireAdversarial: true
    });
    assert.equal(gate.passed, false);
    assert.ok(gate.blockers.some(item => item.code === 'EVALUATION_TARGET_VERSION_MISMATCH'));
    assert.ok(gate.blockers.some(item => item.code === 'EVALUATION_SMOKE_ONLY'));
    assert.ok(gate.blockers.some(item => item.code === 'EVALUATION_HARD_FAILURE'));
    assert.ok(gate.blockers.some(item => item.code === 'EVALUATION_TIER_MISSING' && item.tier === 'adversarial'));
});

test('evidence anchors are hard evaluation rules and risky workflow impact requires adversarial coverage', () => {
    const graded = gradeAgentOutput({
        run: { status: 'completed', final_answer: '结论已形成，但未提供来源编号。' },
        evalCase: { assertions: { requiredEvidencePhrases: ['来源 #42'] } }
    });
    assert.equal(graded.passed, false);
    assert.deepEqual(graded.hardFailures, ['required_evidence']);
    assert.equal(requiresAdversarialCoverage({ summary: { sideEffectCount: 1 } }), true);
    assert.equal(requiresAdversarialCoverage({ summary: { networkCount: 0, credentialCount: 0 } }), false);
});
