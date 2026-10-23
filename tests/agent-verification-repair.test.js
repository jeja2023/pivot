'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { canAttemptVerificationRepair } = require('../server/services/agent-verification-repair');
const { TaskBudget } = require('../server/services/agent-budget');
const { verifyAndRecordTaskOutcome } = require('../server/services/agent-verification');
const { queryOne, execute } = require('../server/db/client');
const { createTaskTransaction, transitionTaskTransaction, getTaskTransactionForUser } = require('../server/services/agent-task-transactions');

test('only bounded internal verification gaps can request another planning attempt', () => {
    const base = { outcomeStatus: 'needs_input', taskContract: { repairAttempts: 0 }, hardFailures: ['artifact_required'] };
    const options = { allowed: true, remainingSteps: 3, budget: new TaskBudget() };
    assert.equal(canAttemptVerificationRepair(base, options), true);
    for (const reason of ['source_not_fully_read', 'artifact_not_materialized']) {
        assert.equal(canAttemptVerificationRepair({ ...base, semanticVerification: { reason } }, options), true);
    }
    for (const reason of ['source_revoked', 'verifier_unavailable', 'budget_exceeded']) {
        assert.equal(canAttemptVerificationRepair({ ...base, semanticVerification: { reason } }, options), false);
    }
    assert.equal(canAttemptVerificationRepair({ ...base, hardFailures: ['deliverables_verified'], semanticVerification: { missing: ['缺少统计月份'] } }, options), false);
    assert.equal(canAttemptVerificationRepair({ ...base, taskContract: { repairAttempts: 2 } }, options), false);
    assert.equal(canAttemptVerificationRepair(base, { ...options, remainingSteps: 1 }), false);
    const budget = new TaskBudget({ max_tool_calls: 0 });
    assert.equal(canAttemptVerificationRepair(base, { ...options, budget }), false);
});

test('repairable verification keeps the task transaction executable until final verification succeeds', async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const run = { id: `verify-repair-${process.pid}-${Date.now()}`, user_id: user.id, goal: '生成报告', metadata: {} };
    await execute("INSERT INTO agent_runs (id,user_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,'修复验收','生成报告','verifying','{}',NOW(),NOW())", [run.id, user.id]);
    try {
        const transaction = await createTaskTransaction({ run, user });
        await transitionTaskTransaction(transaction.id, user, 'executing');
        run.metadata = { taskTransactionId: transaction.id, taskContract: { acceptance: { artifactRequired: true } } };
        const persist = async (_id, patch) => { run.metadata = { ...run.metadata, ...patch }; };
        const repair = await verifyAndRecordTaskOutcome({ runId: run.id, run, user, answer: '准备生成文件', observations: [],
            repairOptions: { allowed: true, remainingSteps: 3 }, budget: new TaskBudget(), setRunMetadata: persist });
        assert.equal(repair.repair.allowed, true);
        assert.equal(repair.taskContract.repairAttempts, 1);
        assert.equal((await getTaskTransactionForUser(transaction.id, user)).status, 'executing');
        const completed = await verifyAndRecordTaskOutcome({ runId: run.id, run, user, answer: '报告已生成', observations: [{ output: { artifactId: 'artifact', name: '报告.docx' } }], setRunMetadata: persist });
        assert.equal(completed.outcomeStatus, 'verified');
        assert.equal((await getTaskTransactionForUser(transaction.id, user)).status, 'committed');
    } finally { await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]); }
});
