'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const {
    beginTaskCompensation,
    commitTaskTransaction,
    completeTaskCompensation,
    createTaskTransaction,
    finalizeTaskRollback,
    getTaskTransactionForUser,
    recordTaskTransactionVerification,
    recordTaskWorkspaceSnapshot,
    resolveUncertainTaskEffect,
    stageTaskEffect,
    transitionTaskTransaction,
    updateTaskEffect
} = require('../server/services/agent-task-transactions');
const { verifyAndRecordTaskOutcome } = require('../server/services/agent-verification');
const { executeAndCommitTaskTransaction, stageDeferredToolEffect } = require('../server/services/agent-task-effect-executor');
const { createToolOrchestrator } = require('../server/services/agent-tool-orchestrator');
const { createSubworkflowRuntime } = require('../server/services/agent-dag-subworkflow-runtime');
const { executeDagNodeWithPolicy } = require('../server/services/agent-dag-runtime');

async function createRun(label) {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const runId = `task-transaction-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await execute(`
        INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
        VALUES (?, ?, 'task transaction', '交付受控任务', 'running', '{}', NOW(), NOW())
    `, [runId, user.id]);
    return { run: { id: runId, user_id: user.id, tenant_id: user.tenant_id || 0, goal: '交付受控任务' }, user };
}

async function patchRunMetadata(runId, patch) {
    const row = await queryOne('SELECT metadata FROM agent_runs WHERE id = ?', [runId]);
    const current = row?.metadata && typeof row.metadata === 'object' ? row.metadata : JSON.parse(String(row?.metadata || '{}'));
    const next = { ...current, ...patch };
    await execute('UPDATE agent_runs SET metadata = ?::jsonb, updated_at = NOW() WHERE id = ?', [JSON.stringify(next), runId]);
    return next;
}

test('nested DAG notification is persisted in the parent transaction without sending it', async () => {
    const { run, user } = await createRun('nested-notify');
    let sent = false;
    try {
        const transaction = await createTaskTransaction({ run, user });
        await transitionTaskTransaction(transaction.id, user, 'executing');
        const orchestrator = createToolOrchestrator({
            enforceToolPolicy: ({ input }) => ({ input, decision: 'allow' }),
            beginAgentToolCheckpoint: async () => ({ replay: false }), completeAgentToolCheckpoint: async () => {},
            recordAgentEvent: async () => {}, issueToolExecutionGrant: () => null
        });
        const nodes = new Map();
        const deps = {
            assertRunNotCancelled: async () => {}, listDagNodes: async () => [...nodes.values()],
            upsertDagNode: async (_runId, node, patch) => { const key = patch.nodeKey || node.id; nodes.set(key, { ...nodes.get(key), ...patch, node_key: key }); },
            getSubworkflowInvocation: async () => null, upsertSubworkflowInvocation: async () => {},
            resolveAgentWorkflowVersion: async workflowId => ({
                workflow: { id: workflowId, name: '通知子工作流' }, version: 1, version_id: 1,
                dagSpec: { nodes: [{ id: 'notify', tool: 'workflow.notify', input: { bindingId: 'binding-integration', body: '验收后发送' }, dependsOn: [] }] }
            }),
            resolveAgentWorkflowDependencyBindings: async resolved => resolved,
            maybePauseForApproval: async () => false, isApprovalGranted: () => true,
            withTimeout: async operation => operation(new AbortController().signal),
            recordAgentToolCall: async () => {}, insertStep: async () => {}, listSteps: async () => [],
            agentToolTimeoutMs: 30000,
            executeToolByName: async (name, input, actor, tools, context) => orchestrator.execute({
                run, user: actor, tool: tools.find(tool => tool.name === name), input, context,
                execute: async () => { sent = true; return { sent: true }; }
            })
        };
        const runtime = createSubworkflowRuntime({
            executeDagNodeWithPolicy, buildDagErrorInfo: () => ({}), prepareDagFallbackOutput: () => null,
            buildDagFallbackFinalAnswer: () => '', extractReadableDagOutput: () => '', upsertDagNode: deps.upsertDagNode
        });
        await runtime.executeSubworkflowDag({ input: { workflowId: 10 }, run, user, modelCfg: null,
            toolList: [{ name: 'workflow.notify', side_effect: true }], deadline: Date.now() + 30000, deps, taskTransactionId: transaction.id });
        assert.equal(sent, false);
        const stored = await getTaskTransactionForUser(transaction.id, user);
        assert.equal(stored.effects.length, 1);
        assert.equal(stored.effects[0].effectType, 'workflow.notify');
        assert.equal(stored.effects[0].status, 'staged');
        assert.equal((await recordTaskTransactionVerification(transaction.id, user, { outcomeStatus: 'verified' })).status, 'awaiting_commit');
        assert.equal(sent, false);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
    }
});

test('pre-execution resource conflict closes the checkpoint and retries safely after lease release', async () => {
    const first = await createRun('checkpoint-lease-holder');
    const second = await createRun('checkpoint-lease-waiter');
    const events = [];
    let dispatched = 0;
    let failureCallbacks = 0;
    try {
        const holder = await createTaskTransaction({ run: first.run, user: first.user });
        const waiter = await createTaskTransaction({ run: second.run, user: second.user });
        await transitionTaskTransaction(holder.id, first.user, 'executing');
        await transitionTaskTransaction(waiter.id, second.user, 'executing');
        const bindingId = `checkpoint-conflict-${process.pid}-${Date.now()}`;
        await stageDeferredToolEffect({ transactionId: holder.id, run: first.run, user: first.user,
            tool: { name: 'workflow.notify' }, input: { bindingId, body: '持有资源' }, operationKey: `${first.run.id}:notify` });
        const orchestrator = createToolOrchestrator({
            enforceToolPolicy: ({ input }) => ({ decision: 'allow', input }),
            issueToolExecutionGrant: () => null, recordAgentEvent: async event => events.push(event)
        });
        const operationKey = `${second.run.id}:notify`;
        const request = {
            run: second.run, user: second.user, tool: { name: 'workflow.notify', side_effect: true, idempotent: false },
            input: { bindingId, body: '等待资源' }, context: { taskTransactionId: waiter.id, operationKey, autonomous: true },
            onFailure: async () => { failureCallbacks += 1; }, execute: async () => { dispatched += 1; }
        };
        await assert.rejects(() => orchestrator.execute(request), error => error.code === 'AGENT_RESOURCE_LEASE_CONFLICT');
        const failed = await queryOne('SELECT status, state FROM agent_run_checkpoints WHERE operation_key = ?', [operationKey]);
        assert.equal(failed.status, 'error');
        const failureState = typeof failed.state === 'string' ? JSON.parse(failed.state) : failed.state;
        assert.equal(failureState.errorCode, 'AGENT_RESOURCE_LEASE_CONFLICT');
        assert.equal(failureCallbacks, 1);
        assert.equal(dispatched, 0);
        assert.ok(events.some(event => event.type === 'transaction.denied'));
        await recordTaskTransactionVerification(holder.id, first.user, { outcomeStatus: 'needs_input' });
        const staged = await orchestrator.execute(request);
        assert.equal(staged.staged, true);
        assert.equal(dispatched, 0);
        const checkpoint = await queryOne('SELECT status, attempt FROM agent_run_checkpoints WHERE operation_key = ?', [operationKey]);
        assert.equal(checkpoint.status, 'completed');
        assert.equal(Number(checkpoint.attempt), 2);
        assert.equal((await getTaskTransactionForUser(waiter.id, second.user)).effects.length, 1);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [first.run.id, second.run.id]);
    }
});

test('lost external response marks a non-idempotent checkpoint uncertain and blocks replay', async () => {
    const { run, user } = await createRun('uncertain-dispatch');
    let deliveries = 0;
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => { deliveries += 1; res.destroy(); });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    try {
        const operationKey = `${run.id}:external-write`;
        const events = [];
        const orchestrator = createToolOrchestrator({
            enforceToolPolicy: ({ input }) => ({ decision: 'allow', input }),
            issueToolExecutionGrant: () => null, stageDeferredToolEffect: async () => null,
            recordAgentEvent: async event => events.push(event)
        });
        const request = {
            run, user, tool: { name: 'external.write', side_effect: true, idempotent: false }, input: { id: 'test' },
            context: { operationKey, approvalGranted: true },
            execute: async () => await fetch(`http://127.0.0.1:${server.address().port}/write`, { method: 'POST', body: '测试' })
        };
        await assert.rejects(() => orchestrator.execute(request));
        const checkpoint = await queryOne('SELECT status, state FROM agent_run_checkpoints WHERE operation_key = ?', [operationKey]);
        const state = typeof checkpoint.state === 'string' ? JSON.parse(checkpoint.state) : checkpoint.state;
        assert.equal(checkpoint.status, 'uncertain');
        assert.equal(state.outcomeUncertain, true);
        assert.equal(state.committed, null);
        assert.equal(deliveries, 1);
        assert.ok(events.some(event => event.type === 'tool.failed' && event.payload.outcomeMayBeUncertain === true));
        await assert.rejects(() => orchestrator.execute(request), error => error.code === 'AGENT_RECOVERY_OUTPUT_UNAVAILABLE');
        await assert.rejects(() => orchestrator.execute({ ...request, tool: { ...request.tool, idempotent: true } }), error => error.code === 'AGENT_RECOVERY_OUTPUT_UNAVAILABLE');
        assert.equal(deliveries, 1);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
    }
});

test('manual review resolves an uncertain transaction effect only with durable evidence', async () => {
    const { run, user } = await createRun('manual-uncertain-review');
    try {
        const tx = await createTaskTransaction({ run, user });
        await transitionTaskTransaction(tx.id, user, 'executing');
        const effect = await stageTaskEffect(tx.id, user, {
            effectType: 'agent.http', resourceKeys: [`http-origin:https://manual-review-${process.pid}.example`],
            idempotencyKey: `${run.id}:manual-review`, commitMode: 'after_verify', compensation: { mode: 'none' }
        });
        await recordTaskTransactionVerification(tx.id, user, { outcomeStatus: 'verified' });
        await execute("UPDATE agent_runs SET status = 'awaiting_commit' WHERE id = ?", [run.id]);
        await updateTaskEffect(effect.id, user, 'executing');
        await updateTaskEffect(effect.id, user, 'failed', { errorInfo: { outcomeUncertain: true, errorCode: 'RESPONSE_LOST' } });
        await assert.rejects(() => resolveUncertainTaskEffect(effect.id, user, { conclusion: 'committed', evidence: '短证据' }), error => error.code === 'AGENT_TASK_EFFECT_REVIEW_EVIDENCE_REQUIRED');
        await assert.rejects(() => resolveUncertainTaskEffect(effect.id, user, { conclusion: 'retry', evidence: '外部订单已人工查询并确认不存在' }), error => error.code === 'AGENT_TASK_EFFECT_REVIEW_CONCLUSION_INVALID');
        const resolved = await resolveUncertainTaskEffect(effect.id, user, { conclusion: 'not_committed', evidence: '外部订单号不存在，操作员已在目标系统查询确认。' });
        assert.equal(resolved.status, 'cancelled');
        assert.equal(resolved.errorInfo.outcomeUncertain, false);
        assert.equal(resolved.errorInfo.manualReview.reviewedByUserId, Number(user.id));
        await assert.rejects(() => resolveUncertainTaskEffect(effect.id, user, { conclusion: 'not_committed', evidence: '外部订单号不存在，操作员已在目标系统查询确认。' }), error => error.code === 'AGENT_TASK_EFFECT_NOT_UNCERTAIN');
    } finally { await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]); }
});

test('explicit business idempotency key blocks the same external effect across Runs in one tenant', async () => {
    const first = await createRun('cross-run-business-key-first');
    const second = await createRun('cross-run-business-key-second');
    try {
        const firstTx = await createTaskTransaction(first);
        const secondTx = await createTaskTransaction(second);
        await transitionTaskTransaction(firstTx.id, first.user, 'executing');
        await transitionTaskTransaction(secondTx.id, second.user, 'executing');
        const plan = {
            effectType: 'agent.http', resourceKeys: [`http-origin:https://cross-run-${process.pid}.example`],
            idempotencyKey: 'business:customer-order-20261018-001', commitMode: 'after_verify', compensation: { mode: 'none' }
        };
        await stageTaskEffect(firstTx.id, first.user, plan);
        await assert.rejects(() => stageTaskEffect(secondTx.id, second.user, plan), error => error.code === 'AGENT_TASK_EFFECT_CROSS_RUN_DUPLICATE');
        await assert.doesNotReject(() => stageTaskEffect(secondTx.id, second.user, {
            ...plan,
            resourceKeys: [`http-origin:https://cross-run-other-${process.pid}.example`],
            idempotencyKey: 'business:customer-order-20261018-002'
        }));
    } finally { await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [first.run.id, second.run.id]); }
});

test('concurrent Runs cannot both claim one tenant-scoped business idempotency key', async () => {
    const first = await createRun('concurrent-business-key-first');
    const second = await createRun('concurrent-business-key-second');
    try {
        const firstTx = await createTaskTransaction(first);
        const secondTx = await createTaskTransaction(second);
        await transitionTaskTransaction(firstTx.id, first.user, 'executing');
        await transitionTaskTransaction(secondTx.id, second.user, 'executing');
        const key = `business:concurrent-order-${process.pid}-${Date.now()}`;
        const attempts = await Promise.allSettled([
            stageTaskEffect(firstTx.id, first.user, {
                effectType: 'agent.http', resourceKeys: [`http-origin:https://concurrent-a-${process.pid}.example`],
                idempotencyKey: key, commitMode: 'after_verify', compensation: { mode: 'none' }
            }),
            stageTaskEffect(secondTx.id, second.user, {
                effectType: 'agent.http', resourceKeys: [`http-origin:https://concurrent-b-${process.pid}.example`],
                idempotencyKey: key, commitMode: 'after_verify', compensation: { mode: 'none' }
            })
        ]);
        assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
        const rejected = attempts.find(item => item.status === 'rejected');
        assert.equal(rejected.reason.code, 'AGENT_TASK_EFFECT_CROSS_RUN_DUPLICATE');
    } finally { await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [first.run.id, second.run.id]); }
});

test('a declared idempotent tool can retry after an execution error', async () => {
    const { run, user } = await createRun('idempotent-retry');
    try {
        let attempts = 0;
        const operationKey = `${run.id}:read`;
        const orchestrator = createToolOrchestrator({
            enforceToolPolicy: ({ input }) => ({ decision: 'allow', input }),
            issueToolExecutionGrant: () => null, stageDeferredToolEffect: async () => null,
            recordAgentEvent: async () => {}
        });
        const request = {
            run, user, tool: { name: 'example.read', idempotent: true }, input: {}, context: { operationKey },
            execute: async () => { attempts += 1; if (attempts === 1) throw new Error('暂时不可用'); return { ok: true }; }
        };
        await assert.rejects(() => orchestrator.execute(request));
        assert.equal((await queryOne('SELECT status FROM agent_run_checkpoints WHERE operation_key = ?', [operationKey])).status, 'error');
        assert.deepEqual(await orchestrator.execute(request), { ok: true });
        assert.equal(attempts, 2);
        assert.equal((await queryOne('SELECT status FROM agent_run_checkpoints WHERE operation_key = ?', [operationKey])).status, 'completed');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
    }
});

test('transaction commit response loss cannot be retried, cancelled, or falsely rolled back', async () => {
    const { run, user } = await createRun('transaction-uncertain');
    let received = 0;
    const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { received += 1; res.destroy(); }); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
        const tx = await createTaskTransaction({ run, user });
        await transitionTaskTransaction(tx.id, user, 'executing');
        const staged = await stageDeferredToolEffect({ transactionId: tx.id, run, user,
            tool: { name: 'agent.http' }, input: { method: 'POST', url: `http://127.0.0.1:${server.address().port}/commit` },
            operationKey: `${run.id}:commit` });
        await recordTaskTransactionVerification(tx.id, user, { outcomeStatus: 'verified' });
        await execute("UPDATE agent_runs SET status = 'awaiting_commit' WHERE id = ?", [run.id]);
        const deps = { executeEffect: async () => await fetch(`http://127.0.0.1:${server.address().port}/commit`, { method: 'POST', body: '测试' }) };
        await assert.rejects(() => executeAndCommitTaskTransaction(tx.id, user, {}, deps));
        const stored = await getTaskTransactionForUser(tx.id, user);
        assert.equal(stored.status, 'awaiting_commit');
        assert.equal(stored.effects[0].id, staged.effect.id);
        assert.equal(stored.effects[0].status, 'failed');
        assert.equal(stored.effects[0].errorInfo.outcomeUncertain, true);
        assert.equal(received, 1);
        await assert.rejects(() => executeAndCommitTaskTransaction(tx.id, user, {}, deps), error => error.code === 'AGENT_TASK_EFFECT_NOT_READY');
        await assert.rejects(() => beginTaskCompensation(tx.id, user, '测试回滚'), error => error.code === 'AGENT_TASK_EFFECT_OUTCOME_UNCERTAIN');
        await assert.rejects(() => transitionTaskTransaction(tx.id, user, 'cancelled'), error => error.code === 'AGENT_TASK_EFFECT_OUTCOME_UNCERTAIN');
        await assert.rejects(() => transitionTaskTransaction(tx.id, user, 'committed'), error => error.code === 'AGENT_TASK_TRANSACTION_CONTROLLED_TRANSITION_REQUIRED');
        await assert.rejects(() => transitionTaskTransaction(tx.id, user, 'compensating'), error => error.code === 'AGENT_TASK_TRANSACTION_CONTROLLED_TRANSITION_REQUIRED');
        assert.equal(received, 1);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
    }
});

test('a committed irreversible effect prevents a transaction from claiming rollback', async () => {
    const { run, user } = await createRun('irreversible-effect');
    try {
        const tx = await createTaskTransaction({ run, user });
        await transitionTaskTransaction(tx.id, user, 'executing');
        const effect = await stageTaskEffect(tx.id, user, { effectType: 'workflow.notify', resourceKeys: [],
            idempotencyKey: `${run.id}:notification`, commitMode: 'after_verify', compensation: { mode: 'none' } });
        await recordTaskTransactionVerification(tx.id, user, { outcomeStatus: 'verified' });
        await updateTaskEffect(effect.id, user, 'executing');
        await updateTaskEffect(effect.id, user, 'committed', { result: { queued: true } });
        await assert.rejects(() => beginTaskCompensation(tx.id, user, '测试回滚'), error => error.code === 'AGENT_TASK_EFFECT_IRREVERSIBLE');
        await assert.rejects(() => transitionTaskTransaction(tx.id, user, 'cancelled'), error => error.code === 'AGENT_TASK_EFFECT_IRREVERSIBLE');
        assert.equal((await getTaskTransactionForUser(tx.id, user)).status, 'awaiting_commit');
        // 历史异常状态也不能绕过最终回滚检查。
        await execute("UPDATE agent_task_transactions SET status = 'compensating' WHERE id = ?", [tx.id]);
        await assert.rejects(() => finalizeTaskRollback(tx.id, user), error => error.code === 'AGENT_TASK_EFFECT_IRREVERSIBLE');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
    }
});

test('persisted transaction gates effect commit on verification and records immutable commit evidence', async () => {
    const { run, user } = await createRun('commit');
    try {
        const created = await createTaskTransaction({
            run, user,
            taskContract: { acceptance: { requiredPhrases: ['已核验'] } },
            effects: [{
                effectType: 'artifact.delivery', resourceKeys: ['artifact:report-1'], idempotencyKey: `${run.id}:deliver`,
                commitMode: 'after_verify', compensation: { mode: 'manual', instructions: '撤销交付令牌。' }
            }]
        });
        assert.equal(created.status, 'planned');
        assert.equal(created.effects.length, 1);
        const executing = await transitionTaskTransaction(created.id, user, 'executing');
        assert.equal(executing.status, 'executing');
        const staged = await updateTaskEffect(created.effects[0].id, user, 'staged', { result: { previewRef: 'cas://preview-1' } });
        assert.equal(staged.status, 'staged');
        await assert.rejects(
            () => updateTaskEffect(staged.id, user, 'committed', { result: { deliveryId: 'd1' } }),
            error => error.code === 'AGENT_TASK_EFFECT_VERIFICATION_REQUIRED'
        );
        const verified = await recordTaskTransactionVerification(created.id, user, { outcomeStatus: 'verified', rules: [{ key: 'artifact', passed: true }] });
        assert.equal(verified.status, 'awaiting_commit');
        const committedEffect = await updateTaskEffect(staged.id, user, 'committed', { result: { deliveryId: 'd1' } });
        assert.equal(committedEffect.status, 'committed');
        const committed = await commitTaskTransaction(created.id, user, { approver: user.id, artifactDigest: 'a'.repeat(64) });
        assert.equal(committed.status, 'committed');
        assert.equal(committed.commitEvidence.artifactDigest, 'a'.repeat(64));
        const loaded = await getTaskTransactionForUser(created.id, user);
        assert.equal(loaded.status, 'committed');
        assert.equal(loaded.effects[0].result.deliveryId, 'd1');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
    }
});

test('external effect execution is claimed once and blocks concurrent rollback', async () => {
    const { run, user } = await createRun('commit-race');
    try {
        const tx = await createTaskTransaction({ run, user });
        await transitionTaskTransaction(tx.id, user, 'executing');
        const effect = await stageTaskEffect(tx.id, user, {
            effectType: 'agent.http', resourceKeys: [`http-origin:https://race-${process.pid}.example`],
            idempotencyKey: `${run.id}:write`, commitMode: 'after_verify', compensation: { mode: 'none' }
        });
        await assert.rejects(() => updateTaskEffect(effect.id, user, 'executing'), error => error.code === 'AGENT_TASK_EFFECT_VERIFICATION_REQUIRED');
        await recordTaskTransactionVerification(tx.id, user, { outcomeStatus: 'verified' });
        const claims = await Promise.allSettled([
            updateTaskEffect(effect.id, user, 'executing'), updateTaskEffect(effect.id, user, 'executing')
        ]);
        assert.equal(claims.filter(item => item.status === 'fulfilled').length, 1);
        assert.equal(claims.filter(item => item.status === 'rejected').length, 1);
        await assert.rejects(() => beginTaskCompensation(tx.id, user, '并发回滚'), error => error.code === 'AGENT_TASK_EFFECT_IN_FLIGHT');
        const state = await getTaskTransactionForUser(tx.id, user);
        assert.equal(state.status, 'awaiting_commit');
        assert.equal(state.effects[0].status, 'executing');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
    }
});

test('persisted transaction creates compensation records and requires all compensations before rollback', async () => {
    const { run, user } = await createRun('rollback');
    try {
        const created = await createTaskTransaction({
            run, user,
            effects: [{
                effectType: 'workspace.patch', resourceKeys: ['workspace:run', 'file:src/a.js'], idempotencyKey: `${run.id}:patch`,
                commitMode: 'after_verify', compensation: { mode: 'automatic', action: 'restore_snapshot', instructions: '还原暂存快照。' }
            }]
        });
        await transitionTaskTransaction(created.id, user, 'executing');
        await updateTaskEffect(created.effects[0].id, user, 'staged', { result: { snapshot: 'cas://workspace-before' } });
        const compensating = await beginTaskCompensation(created.id, user, '构建验证失败');
        assert.equal(compensating.status, 'compensating');
        assert.equal(compensating.compensations.length, 1);
        await assert.rejects(
            () => finalizeTaskRollback(created.id, user),
            error => error.code === 'AGENT_TASK_COMPENSATION_PENDING'
        );
        const completion = await completeTaskCompensation(compensating.compensations[0].id, user, { success: true, result: { restored: true } });
        assert.equal(completion.status, 'completed');
        const rolledBack = await finalizeTaskRollback(created.id, user);
        assert.equal(rolledBack.status, 'rolled_back');
        assert.equal(rolledBack.effects[0].status, 'compensated');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
    }
});

test('independent verification automatically commits only an effect-free transaction', async () => {
    const { run, user } = await createRun('verification');
    try {
        const transaction = await createTaskTransaction({
            run, user, taskContract: { acceptance: { requiredPhrases: ['已核验'] } }
        });
        await transitionTaskTransaction(transaction.id, user, 'executing');
        const metadata = { taskTransactionId: transaction.id, taskContract: { acceptance: { requiredPhrases: ['已核验'] } } };
        await patchRunMetadata(run.id, metadata);
        const report = await verifyAndRecordTaskOutcome({
            runId: run.id,
            run: { ...run, metadata },
            user,
            answer: '交付内容已核验。',
            observations: [],
            setRunMetadata: (id, patch) => patchRunMetadata(id, patch)
        });
        assert.equal(report.outcomeStatus, 'verified');
        assert.equal(report.taskTransaction.status, 'committed');
        const stored = await getTaskTransactionForUser(transaction.id, user);
        assert.equal(stored.status, 'committed');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
    }
});

test('independent verification leaves an uncommitted side effect awaiting explicit commit evidence', async () => {
    const { run, user } = await createRun('verification-effect');
    try {
        const transaction = await createTaskTransaction({
            run, user, taskContract: { acceptance: { requiredPhrases: ['已核验'] } }
        });
        await transitionTaskTransaction(transaction.id, user, 'executing');
        await stageTaskEffect(transaction.id, user, {
            effectType: 'workspace.patch', resourceKeys: ['workspace:verified'], idempotencyKey: `${run.id}:patch`,
            commitMode: 'after_verify', compensation: { mode: 'automatic', action: 'restore_snapshot' }
        }, { patchRef: 'cas://patch-preview' });
        const metadata = { taskTransactionId: transaction.id, taskContract: { acceptance: { requiredPhrases: ['已核验'] } } };
        await patchRunMetadata(run.id, metadata);
        const report = await verifyAndRecordTaskOutcome({
            runId: run.id,
            run: { ...run, metadata },
            user,
            answer: '交付内容已核验。',
            observations: [],
            setRunMetadata: (id, patch) => patchRunMetadata(id, patch)
        });
        assert.equal(report.outcomeStatus, 'verified');
        assert.equal(report.taskTransaction.status, 'awaiting_commit');
        const stored = await getTaskTransactionForUser(transaction.id, user);
        assert.equal(stored.status, 'awaiting_commit');
        assert.equal(stored.effects[0].status, 'staged');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
    }
});

test('deferred notification is persisted as a staged effect and has no delivery result before final commit', async () => {
    const { run, user } = await createRun('notify-stage');
    try {
        const transaction = await createTaskTransaction({ run, user });
        await transitionTaskTransaction(transaction.id, user, 'executing');
        const staged = await stageDeferredToolEffect({
            transactionId: transaction.id,
            user,
            run,
            tool: { name: 'workflow.notify' },
            input: { bindingId: 'binding-safe', body: '验收后再发送' },
            operationKey: `${run.id}:notify`
        });
        assert.equal(staged.effect.status, 'staged');
        assert.equal(staged.effect.commitMode, 'after_verify');
        const stored = await getTaskTransactionForUser(transaction.id, user);
        assert.equal(stored.effects.length, 1);
        assert.deepEqual(stored.effects[0].result, {});
        assert.deepEqual(stored.effects[0].resourceKeys, ['channel-binding:binding-safe']);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
    }
});

test('workspace preview records shadow-worktree status metadata and requires manual preservation', async () => {
    const { run, user } = await createRun('workspace-snapshot');
    try {
        const transaction = await createTaskTransaction({
            run, user, workspaceSnapshot: { kind: 'run_control_plane', runMode: 'standard' }
        });
        await transitionTaskTransaction(transaction.id, user, 'executing');
        const updated = await recordTaskWorkspaceSnapshot(transaction.id, user, {
            worktreeName: 'preview-snapshot', branch: 'codex/preview-snapshot',
            head: 'a'.repeat(40), revision: 'b'.repeat(64), effectId: 'effect-preview'
        });
        assert.equal(updated.workspaceSnapshot.kind, 'run_control_plane', '运行控制面元数据必须保留');
        assert.equal(updated.workspaceSnapshot.shadowWorktrees.length, 1);
        assert.deepEqual(updated.workspaceSnapshot.shadowWorktrees[0], {
            kind: 'shadow_worktree', worktreeName: 'preview-snapshot', branch: 'codex/preview-snapshot',
            head: 'a'.repeat(40), revision: 'b'.repeat(64), effectId: 'effect-preview',
            recovery: 'manual_preservation_required', capturedAt: updated.workspaceSnapshot.shadowWorktrees[0].capturedAt
        });
        await assert.rejects(
            () => recordTaskWorkspaceSnapshot(transaction.id, user, { worktreeName: '../primary' }),
            error => error.code === 'AGENT_WORKSPACE_SNAPSHOT_INVALID'
        );
        await assert.rejects(
            () => recordTaskWorkspaceSnapshot(transaction.id, user, { worktreeName: 'preview-snapshot', archiveDigest: 'c'.repeat(64) }),
            error => error.code === 'AGENT_WORKSPACE_RECOVERY_SNAPSHOT_INCOMPLETE'
        );
        const recoverable = await recordTaskWorkspaceSnapshot(transaction.id, user, { worktreeName: 'recoverable-snapshot', archiveDigest: 'c'.repeat(64), restoreHandle: 'connector-snapshot:opaque-1' });
        assert.equal(recoverable.workspaceSnapshot.shadowWorktrees.find(item => item.worktreeName === 'recoverable-snapshot').recovery, 'controlled_restore_available');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
    }
});

test('staged effects acquire cross-run resource leases, reject conflicts, and release them on a non-delivery terminal state', async () => {
    const first = await createRun('resource-lease-a');
    const second = await createRun('resource-lease-b');
    try {
        const transactionA = await createTaskTransaction({ run: first.run, user: first.user });
        const transactionB = await createTaskTransaction({ run: second.run, user: second.user });
        await transitionTaskTransaction(transactionA.id, first.user, 'executing');
        await transitionTaskTransaction(transactionB.id, second.user, 'executing');
        await stageTaskEffect(transactionA.id, first.user, {
            effectType: 'agent.http', resourceKeys: ['http-origin:https://api.example.test'], idempotencyKey: `${first.run.id}:http`,
            commitMode: 'after_verify', compensation: { mode: 'none' }
        }, { request: 'a' });
        const locked = await getTaskTransactionForUser(transactionA.id, first.user);
        assert.equal(locked.resourceLeases.length, 1);
        assert.equal(locked.resourceLeases[0].resourceKey, 'http-origin:https://api.example.test');
        await assert.rejects(
            () => stageTaskEffect(transactionB.id, second.user, {
                effectType: 'agent.http', resourceKeys: ['http-origin:https://api.example.test'], idempotencyKey: `${second.run.id}:http`,
                commitMode: 'after_verify', compensation: { mode: 'none' }
            }, { request: 'b' }),
            error => error.code === 'AGENT_RESOURCE_LEASE_CONFLICT'
        );
        const conflicted = await getTaskTransactionForUser(transactionB.id, second.user);
        assert.equal(conflicted.resourceConflicts.length, 1);
        assert.equal(conflicted.resourceConflicts[0].resourceKey, 'http-origin:https://api.example.test');
        assert.equal(conflicted.resourceConflicts[0].holderTransactionId, transactionA.id);
        assert.equal(conflicted.resourceConflicts[0].holderRunId, first.run.id);
        assert.ok(conflicted.resourceConflicts[0].observedLeaseExpiresAt);
        await recordTaskTransactionVerification(transactionA.id, first.user, { outcomeStatus: 'needs_input', reason: '用户取消交付' });
        const released = await getTaskTransactionForUser(transactionB.id, second.user);
        assert.equal(released.resourceConflicts[0].status, 'released');
        await stageTaskEffect(transactionB.id, second.user, {
            effectType: 'agent.http', resourceKeys: ['http-origin:https://api.example.test'], idempotencyKey: `${second.run.id}:http`,
            commitMode: 'after_verify', compensation: { mode: 'none' }
        }, { request: 'b' });
        const acquired = await getTaskTransactionForUser(transactionB.id, second.user);
        assert.equal(acquired.resourceLeases.filter(item => !item.releasedAt).length, 1);
        assert.equal(acquired.resourceConflicts[0].status, 'resolved', '申请方获得资源后应关闭对应冲突记录');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [first.run.id, second.run.id]);
    }
});

test('expired or released leases cannot expose resources with executing or failed effects to another run', async () => {
    const holder = await createRun('quarantine-holder');
    const waiter = await createRun('quarantine-waiter');
    try {
        const txA = await createTaskTransaction({ run: holder.run, user: holder.user });
        const txB = await createTaskTransaction({ run: waiter.run, user: waiter.user });
        await transitionTaskTransaction(txA.id, holder.user, 'executing');
        await transitionTaskTransaction(txB.id, waiter.user, 'executing');
        const resourceKey = `http-origin:https://quarantine-${process.pid}-${Date.now()}.example`;
        const plan = { effectType: 'agent.http', resourceKeys: [resourceKey], commitMode: 'after_verify', compensation: { mode: 'none' } };
        const first = await stageTaskEffect(txA.id, holder.user, { ...plan, idempotencyKey: `${holder.run.id}:http` });
        await recordTaskTransactionVerification(txA.id, holder.user, { outcomeStatus: 'verified' });
        await updateTaskEffect(first.id, holder.user, 'executing');
        await execute("UPDATE agent_task_resource_leases SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE effect_id = ?", [first.id]);
        const attempt = () => stageTaskEffect(txB.id, waiter.user, { ...plan, idempotencyKey: `${waiter.run.id}:http` });
        await assert.rejects(attempt, error => error.code === 'AGENT_RESOURCE_LEASE_CONFLICT' && /待核实/.test(error.message));
        await updateTaskEffect(first.id, holder.user, 'failed', { errorInfo: { outcomeUncertain: true } });
        await execute('UPDATE agent_task_resource_leases SET released_at = NOW() WHERE effect_id = ?', [first.id]);
        await assert.rejects(attempt, error => error.code === 'AGENT_RESOURCE_LEASE_CONFLICT' && /待核实/.test(error.message));
        // 模拟旧版本没有保留租约行时，仍须根据 effect 的资源声明隔离。
        await execute('DELETE FROM agent_task_resource_leases WHERE effect_id = ?', [first.id]);
        await assert.rejects(attempt, error => error.code === 'AGENT_RESOURCE_LEASE_CONFLICT' && /待核实/.test(error.message));
        assert.equal((await getTaskTransactionForUser(txB.id, waiter.user)).effects.length, 0);
        const conflicts = (await getTaskTransactionForUser(txB.id, waiter.user)).resourceConflicts;
        assert.ok(conflicts.some(item => item.holderEffectId === first.id && item.status === 'open'));
        await execute("UPDATE agent_task_effects SET status = 'compensation_pending' WHERE id = ?", [first.id]);
        await assert.rejects(attempt, error => error.code === 'AGENT_RESOURCE_LEASE_CONFLICT');
        // 测试夹具模拟经外部核实并解决后的状态；不代表已实现人工核对功能。
        await execute("UPDATE agent_task_effects SET status = 'compensated' WHERE id = ?", [first.id]);
        const acquired = await attempt();
        assert.equal(acquired.status, 'staged');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [holder.run.id, waiter.run.id]);
    }
});

test('an expired staged effect cannot begin execution after another run acquires its resource', async () => {
    const holder = await createRun('expired-holder');
    const waiter = await createRun('expired-waiter');
    try {
        const txA = await createTaskTransaction({ run: holder.run, user: holder.user });
        const txB = await createTaskTransaction({ run: waiter.run, user: waiter.user });
        await transitionTaskTransaction(txA.id, holder.user, 'executing');
        await transitionTaskTransaction(txB.id, waiter.user, 'executing');
        const resourceKey = `http-origin:https://expired-${process.pid}-${Date.now()}.example`;
        const plan = { effectType: 'agent.http', resourceKeys: [resourceKey], commitMode: 'after_verify', compensation: { mode: 'none' } };
        const first = await stageTaskEffect(txA.id, holder.user, { ...plan, idempotencyKey: `${holder.run.id}:http` });
        await execute("UPDATE agent_task_resource_leases SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE effect_id = ?", [first.id]);
        await stageTaskEffect(txB.id, waiter.user, { ...plan, idempotencyKey: `${waiter.run.id}:http` });
        await recordTaskTransactionVerification(txA.id, holder.user, { outcomeStatus: 'verified' });
        await assert.rejects(() => updateTaskEffect(first.id, holder.user, 'executing'), error => error.code === 'AGENT_RESOURCE_LEASE_LOST');
        assert.equal((await getTaskTransactionForUser(txA.id, holder.user)).effects[0].status, 'staged');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [holder.run.id, waiter.run.id]);
    }
});

test('committed effects remain quarantined until their transaction is committed', async () => {
    const holder = await createRun('committed-lease-holder');
    const waiter = await createRun('committed-lease-waiter');
    try {
        const txA = await createTaskTransaction({ run: holder.run, user: holder.user });
        const txB = await createTaskTransaction({ run: waiter.run, user: waiter.user });
        await transitionTaskTransaction(txA.id, holder.user, 'executing');
        await transitionTaskTransaction(txB.id, waiter.user, 'executing');
        const resourceKey = `http-origin:https://committed-${process.pid}-${Date.now()}.example`;
        const plan = { effectType: 'agent.http', resourceKeys: [resourceKey], commitMode: 'after_verify', compensation: { mode: 'none' } };
        const first = await stageTaskEffect(txA.id, holder.user, { ...plan, idempotencyKey: `${holder.run.id}:http` });
        await recordTaskTransactionVerification(txA.id, holder.user, { outcomeStatus: 'verified' });
        await updateTaskEffect(first.id, holder.user, 'executing');
        await updateTaskEffect(first.id, holder.user, 'committed', { result: { accepted: true } });
        await execute("UPDATE agent_task_resource_leases SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE effect_id = ?", [first.id]);
        const attempt = () => stageTaskEffect(txB.id, waiter.user, { ...plan, idempotencyKey: `${waiter.run.id}:http` });
        await assert.rejects(attempt, error => error.code === 'AGENT_RESOURCE_LEASE_CONFLICT');
        assert.equal((await commitTaskTransaction(txA.id, holder.user, { kind: 'test' })).status, 'committed');
        assert.equal((await attempt()).status, 'staged');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [holder.run.id, waiter.run.id]);
    }
});

test('a completed preview stays quarantined while its transaction is still pending', async () => {
    const holder = await createRun('preview-lease-holder');
    const waiter = await createRun('preview-lease-waiter');
    try {
        const txA = await createTaskTransaction({ run: holder.run, user: holder.user });
        const txB = await createTaskTransaction({ run: waiter.run, user: waiter.user });
        await transitionTaskTransaction(txA.id, holder.user, 'executing');
        await transitionTaskTransaction(txB.id, waiter.user, 'executing');
        const resourceKey = `workspace-worktree:preview-${process.pid}-${Date.now()}`;
        const plan = { effectType: 'mcp.workspace.patch', resourceKeys: [resourceKey], commitMode: 'preview', compensation: { mode: 'manual' } };
        const first = await stageTaskEffect(txA.id, holder.user, { ...plan, idempotencyKey: `${holder.run.id}:patch` });
        await updateTaskEffect(first.id, holder.user, 'executing');
        await updateTaskEffect(first.id, holder.user, 'staged', { result: { preview: true } });
        await execute("UPDATE agent_task_resource_leases SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE effect_id = ?", [first.id]);
        await assert.rejects(() => stageTaskEffect(txB.id, waiter.user, { ...plan, idempotencyKey: `${waiter.run.id}:patch` }), error => error.code === 'AGENT_RESOURCE_LEASE_CONFLICT');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [holder.run.id, waiter.run.id]);
    }
});

test('expired lease takeover and original execution cannot both succeed concurrently', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const holder = await createRun('takeover-race-holder');
        const waiter = await createRun('takeover-race-waiter');
        try {
            const txA = await createTaskTransaction({ run: holder.run, user: holder.user });
            const txB = await createTaskTransaction({ run: waiter.run, user: waiter.user });
            await transitionTaskTransaction(txA.id, holder.user, 'executing');
            await transitionTaskTransaction(txB.id, waiter.user, 'executing');
            const resourceKey = `http-origin:https://takeover-${process.pid}-${Date.now()}-${attempt}.example`;
            const plan = { effectType: 'agent.http', resourceKeys: [resourceKey], commitMode: 'after_verify', compensation: { mode: 'none' } };
            const first = await stageTaskEffect(txA.id, holder.user, { ...plan, idempotencyKey: `${holder.run.id}:http` });
            await recordTaskTransactionVerification(txA.id, holder.user, { outcomeStatus: 'verified' });
            await execute("UPDATE agent_task_resource_leases SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE effect_id = ?", [first.id]);
            const results = await Promise.allSettled([
                updateTaskEffect(first.id, holder.user, 'executing'),
                stageTaskEffect(txB.id, waiter.user, { ...plan, idempotencyKey: `${waiter.run.id}:http` })
            ]);
            assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
            const failure = results.find(item => item.status === 'rejected');
            assert.ok(['AGENT_RESOURCE_LEASE_CONFLICT', 'AGENT_RESOURCE_LEASE_LOST'].includes(failure.reason.code));
            const states = await Promise.all([getTaskTransactionForUser(txA.id, holder.user), getTaskTransactionForUser(txB.id, waiter.user)]);
            assert.equal(Number(states[0].effects[0].status === 'executing') + Number(states[1].effects.some(effect => effect.status === 'staged')), 1);
        } finally {
            await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [holder.run.id, waiter.run.id]);
        }
    }
});
