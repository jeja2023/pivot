'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const {
    createTaskTransaction,
    getTaskTransactionForUser,
    recordTaskTransactionVerification,
    stageTaskEffect,
    transitionTaskTransaction
} = require('../server/services/agent-task-transactions');
const { recordCollaboratorCompletion } = require('../server/services/agent-collaboration');
const { acknowledgeAppliedAgentControlMessages, applyAgentControlMessages, claimAgentControlMessages } = require('../server/services/agent-control');
const { executeAgentJoin } = require('../server/services/agent-tools-collaboration');

test('协作子任务的资源等待、失败释放和 Handoff 验收形成完整 Supervisor 故障演练', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const supervisorId = `supervisor-resource-${suffix}`;
    const holderId = `holder-resource-${suffix}`;
    const waiterId = `waiter-resource-${suffix}`;
    const resourceKey = `http-origin:https://collaboration-${suffix}.example`;
    try {
        await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, 'supervisor', '汇合资源冲突子任务', 'running', '{}'::jsonb, NOW(), NOW())", [supervisorId, user.id]);
        for (const [id, title] of [[holderId, '资源持有子任务'], [waiterId, '资源等待子任务']]) {
            await execute("INSERT INTO agent_runs (id, user_id, parent_run_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, '处理共享资源', 'running', ?::jsonb, NOW(), NOW())", [id, user.id, supervisorId, title, JSON.stringify({ source: 'delegation', collaboration: { supervisorRunId: supervisorId } })]);
        }
        const holderRun = await queryOne('SELECT * FROM agent_runs WHERE id = ?', [holderId]);
        const waiterRun = await queryOne('SELECT * FROM agent_runs WHERE id = ?', [waiterId]);
        const holderTx = await createTaskTransaction({ run: holderRun, user });
        const waiterTx = await createTaskTransaction({ run: waiterRun, user });
        await transitionTaskTransaction(holderTx.id, user, 'executing');
        await transitionTaskTransaction(waiterTx.id, user, 'executing');
        await stageTaskEffect(holderTx.id, user, {
            effectType: 'agent.http', resourceKeys: [resourceKey], idempotencyKey: `${holderId}:effect`, commitMode: 'after_verify', compensation: { mode: 'none' }
        }, { request: 'holder' });
        await assert.rejects(
            () => stageTaskEffect(waiterTx.id, user, {
                effectType: 'agent.http', resourceKeys: [resourceKey], idempotencyKey: `${waiterId}:effect`, commitMode: 'after_verify', compensation: { mode: 'none' }
            }, { request: 'waiter' }),
            error => error.code === 'AGENT_RESOURCE_LEASE_CONFLICT'
        );
        const blocked = await executeAgentJoin({}, user, { run: { id: supervisorId, user_id: user.id } });
        assert.equal(blocked.complete, false);
        assert.equal(blocked.accepted, false);
        const waitingTx = await getTaskTransactionForUser(waiterTx.id, user);
        assert.equal(waitingTx.resourceConflicts[0].resourceKey, resourceKey);
        assert.equal(waitingTx.resourceConflicts[0].status, 'open');
        await recordTaskTransactionVerification(holderTx.id, user, { outcomeStatus: 'needs_input', reason: '持有方失败，转人工处理' });
        await stageTaskEffect(waiterTx.id, user, {
            effectType: 'agent.http', resourceKeys: [resourceKey], idempotencyKey: `${waiterId}:effect`, commitMode: 'after_verify', compensation: { mode: 'none' }
        }, { request: 'waiter' });
        assert.equal((await getTaskTransactionForUser(waiterTx.id, user)).resourceConflicts[0].status, 'resolved');
        await execute("UPDATE agent_runs SET status = 'error', error_message = '资源持有方转人工处理', completed_at = NOW(), updated_at = NOW() WHERE id = ?", [holderId]);
        await execute("UPDATE agent_runs SET status = 'completed', final_answer = '等待方已验证交付', completed_at = NOW(), updated_at = NOW() WHERE id = ?", [waiterId]);
        await execute("INSERT INTO agent_verifications (id, run_id, user_id, contract, outcome_status, report, created_at, updated_at) VALUES (?, ?, ?, '{}'::jsonb, 'verified', '{}'::jsonb, NOW(), NOW())", [`verify-${waiterId}`, waiterId, user.id]);
        await recordCollaboratorCompletion(waiterId, 'completed');
        const messages = await claimAgentControlMessages(supervisorId, user);
        assert.equal(messages.length, 1);
        const applied = await applyAgentControlMessages(supervisorId, user, messages);
        assert.equal(applied.length, 1);
        await acknowledgeAppliedAgentControlMessages(supervisorId, user, applied);
        const joined = await executeAgentJoin({}, user, { run: { id: supervisorId, user_id: user.id } });
        assert.equal(joined.complete, true);
        assert.equal(joined.accepted, false);
        assert.equal(joined.results.length, 2);
        assert.equal(joined.results.find(item => item.id === waiterId).accepted, true);
        assert.match(joined.results.find(item => item.id === holderId).rejectionReason, /不能作为已验收交付/);
    } finally {
        await execute('DELETE FROM agent_control_messages WHERE from_run_id IN (?, ?, ?) OR to_run_id IN (?, ?, ?)', [supervisorId, holderId, waiterId, supervisorId, holderId, waiterId]);
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?, ?)', [supervisorId, holderId, waiterId]);
    }
});
