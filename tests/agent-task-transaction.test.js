'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    assertCommitReady,
    assertTransactionTransition,
    createTaskTransactionDraft,
    normalizeEffectPlan
} = require('../server/services/agent-task-transaction');

test('task transaction freezes effect idempotency, resource scope, commit mode and compensation', () => {
    const draft = createTaskTransactionDraft({
        runId: 'run-tx-1', userId: 7, tenantId: 2, goal: '生成并交付报告',
        effects: [{ effectType: 'artifact.delivery', resourceKeys: ['artifact:42', 'delivery:42', 'artifact:42'], idempotencyKey: 'run-tx-1:delivery:42', commitMode: 'after_verify', compensation: { mode: 'manual', instructions: '撤销下载令牌并通知接收人。' } }]
    });
    assert.equal(draft.status, 'draft');
    assert.equal(draft.effects.length, 1);
    assert.deepEqual(draft.effects[0].resourceKeys, ['artifact:42', 'delivery:42']);
    assert.equal(draft.effects[0].compensation.required, true);
});

test('task transaction rejects irreversible effects that falsely promise automatic compensation', () => {
    assert.throws(
        () => normalizeEffectPlan({ effectType: 'external.send', idempotencyKey: 'x', commitMode: 'irreversible', compensation: { mode: 'automatic' } }),
        error => error.code === 'AGENT_TASK_EFFECT_COMPENSATION_INVALID'
    );
});

test('task transaction can commit only after an independent verification and all effects are committed', () => {
    const transaction = createTaskTransactionDraft({ runId: 'run-tx-2', userId: 7, taskContract: { goal: '交付结果' } });
    transaction.status = 'awaiting_commit';
    assert.equal(assertCommitReady(transaction, [{ commitMode: 'after_verify', status: 'committed' }], { outcomeStatus: 'verified' }), true);
    assert.throws(
        () => assertCommitReady(transaction, [{ commitMode: 'after_verify', status: 'staged' }], { outcomeStatus: 'verified' }),
        error => error.code === 'AGENT_TASK_TRANSACTION_EFFECTS_PENDING'
    );
    assert.throws(
        () => assertCommitReady(transaction, [], { outcomeStatus: 'needs_input' }),
        error => error.code === 'AGENT_TASK_TRANSACTION_VERIFICATION_REQUIRED'
    );
});

test('task transaction state machine disallows jumping directly from execution to commit', () => {
    assert.equal(assertTransactionTransition('executing', 'verifying'), 'verifying');
    assert.equal(assertTransactionTransition('verifying', 'awaiting_commit'), 'awaiting_commit');
    assert.throws(
        () => assertTransactionTransition('executing', 'committed'),
        error => error.code === 'AGENT_TASK_TRANSACTION_TRANSITION_INVALID'
    );
});

test('unfinished or failed preview effects block transaction commit', () => {
    const tx = { status: 'awaiting_commit', verification: { outcomeStatus: 'verified' } };
    for (const status of ['executing', 'failed', 'planned']) {
        assert.throws(() => assertCommitReady(tx, [{ commitMode: 'preview', status }]), error => error.code === 'AGENT_TASK_TRANSACTION_EFFECTS_PENDING');
    }
    assert.equal(assertCommitReady(tx, [{ commitMode: 'preview', status: 'staged' }]), true);
});
