'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const {
    importFrozenDecisionEvaluationSet,
    listDecisionEvaluationCases,
    reviewDecisionEvaluationCase
} = require('../server/services/decision-evaluation-reviews');

test('冻结决策金标必须由两名不同审核员一致确认，单人或分歧均不能放行', async () => {
    const reviewerOne = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(reviewerOne?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const reviewerTwo = await queryOne("INSERT INTO users (username, password_hash, nickname, role, status) VALUES (?, 'hash', '第二审核员', 'admin', 'active') RETURNING id", [`decision-reviewer-${suffix}`]);
    const version = 'v2';
    try {
        await importFrozenDecisionEvaluationSet({ userId: reviewerOne.id });
        const [first] = await listDecisionEvaluationCases({ version, limit: 1 });
        assert.ok(first?.caseId);
        const action = first.candidates.find(candidate => candidate.allowed !== false)?.id;
        assert.ok(action);
        const firstReview = await reviewDecisionEvaluationCase({ version, caseId: first.caseId, expectedActionId: action, reviewerId: reviewerOne.id, reviewNote: '第一位审核员确认。' });
        assert.equal(firstReview.reviewStatus, 'pending_human_review');
        assert.equal(firstReview.requiresAnotherReviewer, true);
        const repeated = await reviewDecisionEvaluationCase({ version, caseId: first.caseId, expectedActionId: action, reviewerId: reviewerOne.id, reviewNote: '同一审核员再次确认。' });
        assert.equal(repeated.reviewStatus, 'pending_human_review');
        assert.equal(repeated.distinctReviewerCount, 1);
        const confirmed = await reviewDecisionEvaluationCase({ version, caseId: first.caseId, expectedActionId: action, reviewerId: reviewerTwo.id, reviewNote: '第二位审核员独立确认。' });
        assert.equal(confirmed.reviewStatus, 'verified');
        assert.equal(confirmed.distinctReviewerCount, 2);
        const stored = await queryOne('SELECT review_status, expected_action_id, reviewed_by FROM decision_evaluation_cases WHERE set_version = ? AND case_id = ?', [version, first.caseId]);
        assert.equal(stored.review_status, 'verified');
        assert.equal(stored.expected_action_id, action);
        assert.equal(Number(stored.reviewed_by), Number(reviewerTwo.id));
        const disagreement = await reviewDecisionEvaluationCase({ version, caseId: first.caseId, expectedActionId: first.candidates.find(candidate => candidate.id !== action && candidate.allowed !== false)?.id, reviewerId: reviewerTwo.id, reviewNote: '第二位审核员改为不同动作。' });
        assert.equal(disagreement.reviewStatus, 'human_review_conflict');
        const blocked = await queryOne('SELECT review_status, expected_action_id FROM decision_evaluation_cases WHERE set_version = ? AND case_id = ?', [version, first.caseId]);
        assert.equal(blocked.review_status, 'human_review_conflict');
        assert.equal(blocked.expected_action_id, '');
    } finally {
        await execute('DELETE FROM decision_evaluation_sets WHERE version = ?', [version]);
        await execute('DELETE FROM users WHERE id = ?', [reviewerTwo.id]);
    }
});
