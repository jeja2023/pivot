const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const {
    acknowledgeAppliedAgentControlMessages,
    acknowledgeAgentControlMessage,
    applyAgentControlMessages,
    claimAgentControlMessages,
    listAppliedAgentControlMessages,
    listAgentControlMessages,
    sendAgentControlMessage
} = require('../server/services/agent-control');
const { runs: { cancelAgentRun, softDeleteAgentRun } } = require('../server/services/agent-runtime');
const { beginAgentToolCheckpoint, failAgentToolCheckpoint } = require('../server/services/agent-checkpoints');
const { createTaskTransaction, recordTaskTransactionVerification, stageTaskEffect, transitionTaskTransaction, updateTaskEffect } = require('../server/services/agent-task-transactions');
const { executeAndCommitTaskTransaction } = require('../server/services/agent-task-effect-executor');

test('AgentControl delivers parent-child messages with user isolation and acknowledgement', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const parentId = `control-parent-${suffix}`;
    const childId = `control-child-${suffix}`;
    const otherUser = { id: Number(user.id) + 999999 };
    const otherRunId = `control-other-${suffix}`;
    const insert = async (id, title, goal, parentRunId) => execute(`
        INSERT INTO agent_runs (id, user_id, title, goal, status, parent_run_id, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', ?, '{}', ?, ?)
    `, [id, user.id, title, goal, parentRunId, now, now]);
    const now = '2026-08-22 12:00:00';
    await insert(parentId, 'parent', 'parent', null);
    await insert(childId, 'child', 'child', parentId);
    try {
        const created = await sendAgentControlMessage({
            user,
            fromRunId: parentId,
            toRunId: childId,
            type: 'steer',
            payload: { instruction: '优先核对证据', authorization: 'must-redact' }
        });
        assert.equal(created.status, 'pending');
        assert.equal(created.payload.authorization, '[已脱敏]');

        const listed = await listAgentControlMessages(childId, user, {});
        assert.equal(listed.length, 1);
        assert.equal(listed[0].message_id, created.message_id);

        const claimed = await claimAgentControlMessages(childId, user);
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0].status, 'delivered');
        assert.equal((await claimAgentControlMessages(childId, user)).length, 0);

        const applied = await applyAgentControlMessages(childId, user, claimed);
        assert.equal(applied.length, 1);
        assert.equal(applied[0].status, 'applied');
        assert.equal((await listAgentControlMessages(childId, user, { status: 'applied' })).length, 1);
        assert.equal((await claimAgentControlMessages(childId, user)).length, 0, '已应用但未确认的消息不能被二次应用');
        const appliedAcks = await acknowledgeAppliedAgentControlMessages(childId, user, applied);
        assert.equal(appliedAcks.length, 1);
        assert.equal(appliedAcks[0].status, 'acknowledged');
        assert.equal((await listAgentControlMessages(childId, user, { status: 'acknowledged' })).length, 1);
        assert.equal((await listAppliedAgentControlMessages(childId, user)).length, 1);

        const run = await queryOne('SELECT metadata FROM agent_runs WHERE id = ?', [childId]);
        const metadata = typeof run.metadata === 'string' ? JSON.parse(run.metadata) : run.metadata;
        assert.deepEqual(metadata.controlApplications.messageIds, [created.message_id]);
        assert.equal(metadata.taskContract.revision, 2);
        assert.ok(metadata.taskContract.constraints.includes('优先核对证据'));
        assert.equal(metadata.workingState.constraints.at(-1).text, '优先核对证据');

        const manual = await sendAgentControlMessage({
            user,
            fromRunId: parentId,
            toRunId: childId,
            type: 'request',
            payload: { instruction: '手动确认' }
        });
        const acknowledged = await acknowledgeAgentControlMessage(manual.message_id, user, childId);
        assert.equal(acknowledged.status, 'acknowledged');

        const retryKey = `completion:${childId}`;
        const completionFirst = await sendAgentControlMessage({
            user, fromRunId: childId, toRunId: parentId, type: 'reply',
            payload: { kind: 'delegation_completion', summary: '首次完成回执' }, idempotencyKey: retryKey
        });
        const completionRetry = await sendAgentControlMessage({
            user, fromRunId: childId, toRunId: parentId, type: 'reply',
            payload: { kind: 'delegation_completion', summary: '重试不得产生第二条消息' }, idempotencyKey: retryKey
        });
        assert.equal(completionRetry.message_id, completionFirst.message_id);
        const parentMessages = await listAgentControlMessages(parentId, user, {});
        assert.equal(parentMessages.filter(item => item.message_id === completionFirst.message_id).length, 1);

        await assert.rejects(
            () => sendAgentControlMessage({ user: otherUser, fromRunId: otherRunId, toRunId: childId, payload: { text: 'no' } }),
            error => error.code === 'AGENT_CONTROL_TARGET_NOT_FOUND'
        );
    } finally {
        await execute('DELETE FROM agent_control_messages WHERE from_run_id IN (?, ?) OR to_run_id IN (?, ?)', [parentId, childId, parentId, childId]);
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?, ?)', [parentId, childId, otherRunId]);
    }
});

test('AgentControl reclaims an expired claimed command instead of losing it', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}-lease`;
    const parentId = `control-lease-parent-${suffix}`;
    const childId = `control-lease-child-${suffix}`;
    const now = '2026-08-22 12:00:00';
    const insert = async (id, parentRunId = null) => execute(`
        INSERT INTO agent_runs (id, user_id, title, goal, status, parent_run_id, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', ?, '{}', ?, ?)
    `, [id, user.id, id, id, parentRunId, now, now]);
    await insert(parentId);
    await insert(childId, parentId);
    try {
        await sendAgentControlMessage({ user, fromRunId: parentId, toRunId: childId, payload: { instruction: '不能丢失' } });
        const first = await claimAgentControlMessages(childId, user);
        assert.equal(first.length, 1);
        await execute(`
            UPDATE agent_control_messages
            SET claim_expires_at = NOW() - INTERVAL '1 second'
            WHERE message_id = ?
        `, [first[0].message_id]);
        const second = await claimAgentControlMessages(childId, user);
        assert.equal(second.length, 1);
        assert.notEqual(second[0].claim_token, first[0].claim_token);
        const applied = await applyAgentControlMessages(childId, user, second);
        assert.equal(applied.length, 1);
    } finally {
        await execute('DELETE FROM agent_control_messages WHERE from_run_id IN (?, ?) OR to_run_id IN (?, ?)', [parentId, childId, parentId, childId]);
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [parentId, childId]);
    }
});

test('AgentControl retains non-secret long instructions and rejects oversized payloads', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}-payload`;
    const parentId = `control-payload-parent-${suffix}`;
    const childId = `control-payload-child-${suffix}`;
    const now = '2026-08-22 12:00:00';
    const insert = async (id, parentRunId = null) => execute(`
        INSERT INTO agent_runs (id, user_id, title, goal, status, parent_run_id, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', ?, '{}', ?, ?)
    `, [id, user.id, id, id, parentRunId, now, now]);
    await insert(parentId);
    await insert(childId, parentId);
    try {
        const instruction = '长指令'.repeat(1500);
        const message = await sendAgentControlMessage({
            user,
            fromRunId: parentId,
            toRunId: childId,
            payload: { instruction, token: 'must-redact' }
        });
        assert.equal(message.payload.instruction, instruction);
        assert.equal(message.payload.token, '[已脱敏]');
        await assert.rejects(
            () => sendAgentControlMessage({ user, fromRunId: parentId, toRunId: childId, payload: { instruction: 'x'.repeat(120001) } }),
            error => error.code === 'AGENT_CONTROL_PAYLOAD_TOO_LARGE'
        );
    } finally {
        await execute('DELETE FROM agent_control_messages WHERE from_run_id IN (?, ?) OR to_run_id IN (?, ?)', [parentId, childId, parentId, childId]);
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [parentId, childId]);
    }
});

test('AgentControl rejects unrelated runs in the same user scope', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}-unrelated`;
    const first = `control-first-${suffix}`;
    const second = `control-second-${suffix}`;
    const now = '2026-08-22 12:00:00';
    const insert = async (id, title, goal) => execute(`
        INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', '{}', ?, ?)
    `, [id, user.id, title, goal, now, now]);
    await insert(first, 'first', 'first');
    await insert(second, 'second', 'second');
    try {
        await assert.rejects(
            () => sendAgentControlMessage({ user, fromRunId: first, toRunId: second, payload: { text: 'no' } }),
            error => error.code === 'AGENT_CONTROL_SCOPE_DENIED'
        );
    } finally {
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [first, second]);
    }
});

test('cancelling a parent run propagates to active child runs', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}-cancel`;
    const parent = `control-cancel-parent-${suffix}`;
    const child = `control-cancel-child-${suffix}`;
    const now = '2026-08-22 12:00:00';
    const insert = async (id, title, goal, parentRunId) => execute(`
        INSERT INTO agent_runs (id, user_id, title, goal, status, parent_run_id, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'running', ?, '{}', ?, ?)
    `, [id, user.id, title, goal, parentRunId, now, now]);
    await insert(parent, 'parent', 'parent', null);
    await insert(child, 'child', 'child', parent);
    try {
        await cancelAgentRun(parent, user);
        assert.equal((await queryOne('SELECT status FROM agent_runs WHERE id = ?', [parent])).status, 'cancelled');
        assert.equal((await queryOne('SELECT status FROM agent_runs WHERE id = ?', [child])).status, 'cancelled');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [parent, child]);
    }
});

test('awaiting-commit runs cannot be silently cancelled, including during parent cancellation', async () => {
    const user = await queryOne('SELECT id, username, role FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const parent = `commit-parent-${suffix}`;
    const child = `commit-child-${suffix}`;
    await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, '父任务', '测试取消', 'running', '{}', NOW(), NOW())", [parent, user.id]);
    await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, parent_run_id, metadata, created_at, updated_at) VALUES (?, ?, '子任务', '等待提交', 'awaiting_commit', ?, '{}', NOW(), NOW())", [child, user.id, parent]);
    try {
        await assert.rejects(() => cancelAgentRun(child, user), error => error.code === 'AGENT_TASK_COMMIT_DECISION_REQUIRED');
        await cancelAgentRun(parent, user);
        assert.equal((await queryOne('SELECT status FROM agent_runs WHERE id = ?', [parent])).status, 'cancelled');
        assert.equal((await queryOne('SELECT status FROM agent_runs WHERE id = ?', [child])).status, 'awaiting_commit');
        const step = await queryOne("SELECT output FROM agent_steps WHERE run_id = ? AND title = '用户主动取消运行' ORDER BY step_index DESC LIMIT 1", [parent]);
        const output = typeof step.output === 'string' ? JSON.parse(step.output) : step.output;
        assert.deepEqual(output.pendingCommitChildren, [child]);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [child, parent]);
    }
});

test('cancelled runs with unresolved effects remain visible until safely reconciled', async () => {
    const user = await queryOne('SELECT id, username, role FROM users ORDER BY id LIMIT 1');
    const runId = `unresolved-delete-${process.pid}-${Date.now()}`;
    await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, '待核对任务', '测试删除', 'cancelled', '{}', NOW(), NOW())", [runId, user.id]);
    try {
        const tx = await createTaskTransaction({ run: { id: runId, goal: '测试删除' }, user });
        await transitionTaskTransaction(tx.id, user, 'executing');
        const effect = await stageTaskEffect(tx.id, user, { effectType: 'agent.http', resourceKeys: [],
            idempotencyKey: `${runId}:http`, commitMode: 'after_verify', compensation: { mode: 'none' } });
        await recordTaskTransactionVerification(tx.id, user, { outcomeStatus: 'verified' });
        await updateTaskEffect(effect.id, user, 'executing');
        await updateTaskEffect(effect.id, user, 'failed', { errorInfo: { outcomeUncertain: true } });
        await assert.rejects(() => softDeleteAgentRun(runId, user), error => error.code === 'AGENT_RUN_UNRESOLVED_EFFECTS');
        assert.equal((await queryOne('SELECT deleted_at FROM agent_runs WHERE id = ?', [runId])).deleted_at, null);
        // 仅作为测试夹具模拟已核实状态，产品尚未提供人工消解入口。
        await execute("UPDATE agent_task_effects SET status = 'compensated' WHERE id = ?", [effect.id]);
        assert.ok((await softDeleteAgentRun(runId, user)).deleted_at);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('pending non-idempotent or uncertain checkpoints prevent a cancelled run from being hidden', async () => {
    const user = await queryOne('SELECT id, username, role FROM users ORDER BY id LIMIT 1');
    const runId = `unresolved-checkpoint-${process.pid}-${Date.now()}`;
    await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, '待核对检查点', '测试删除', 'running', '{}', NOW(), NOW())", [runId, user.id]);
    try {
        const operationKey = `${runId}:write`;
        await beginAgentToolCheckpoint(runId, { operationKey, toolName: 'external.write', input: {}, idempotent: false, user });
        await execute("UPDATE agent_runs SET status = 'cancelled' WHERE id = ?", [runId]);
        await assert.rejects(() => softDeleteAgentRun(runId, user), error => error.code === 'AGENT_RUN_UNRESOLVED_EFFECTS');
        await failAgentToolCheckpoint(operationKey, new Error('连接中断'), { executionMayHaveOccurred: true });
        await assert.rejects(() => softDeleteAgentRun(runId, user), error => error.code === 'AGENT_RUN_UNRESOLVED_EFFECTS');
        assert.equal((await queryOne('SELECT deleted_at FROM agent_runs WHERE id = ?', [runId])).deleted_at, null);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('cancellation racing a non-idempotent checkpoint cannot hide an unfinished operation', async () => {
    const user = await queryOne('SELECT id, username, role FROM users ORDER BY id LIMIT 1');
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const runId = `cancel-checkpoint-race-${process.pid}-${Date.now()}-${attempt}`;
        await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, '取消竞争测试', '测试检查点与删除', 'running', '{}', NOW(), NOW())", [runId, user.id]);
        try {
            const results = await Promise.allSettled([
                beginAgentToolCheckpoint(runId, { operationKey: `${runId}:write`, toolName: 'external.write', input: {}, idempotent: false, user }),
                cancelAgentRun(runId, user)
            ]);
            assert.equal(results[1].status, 'fulfilled');
            if (results[0].status === 'fulfilled') {
                await assert.rejects(() => softDeleteAgentRun(runId, user), error => error.code === 'AGENT_RUN_UNRESOLVED_EFFECTS');
                assert.equal((await queryOne('SELECT deleted_at FROM agent_runs WHERE id = ?', [runId])).deleted_at, null);
            } else {
                assert.equal(results[0].reason.code, 'AGENT_CHECKPOINT_RUN_INACTIVE');
                assert.ok((await softDeleteAgentRun(runId, user)).deleted_at);
            }
        } finally {
            await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        }
    }
});

test('a cancelled or hidden run cannot later dispatch staged transaction effects', async () => {
    const user = await queryOne('SELECT id, username, role FROM users ORDER BY id LIMIT 1');
    const runId = `cancelled-commit-${process.pid}-${Date.now()}`;
    await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, '已停止任务', '测试提交边界', 'cancelled', '{}', NOW(), NOW())", [runId, user.id]);
    let dispatched = false;
    try {
        const tx = await createTaskTransaction({ run: { id: runId, goal: '测试提交边界' }, user });
        await transitionTaskTransaction(tx.id, user, 'executing');
        const effect = await stageTaskEffect(tx.id, user, { effectType: 'agent.http', resourceKeys: [],
            idempotencyKey: `${runId}:http`, commitMode: 'after_verify', compensation: { mode: 'none' } });
        await recordTaskTransactionVerification(tx.id, user, { outcomeStatus: 'verified' });
        await assert.rejects(() => executeAndCommitTaskTransaction(tx.id, user, {}, { executeEffect: async () => { dispatched = true; } }), error => error.code === 'AGENT_TASK_RUN_NOT_COMMITTABLE');
        await assert.rejects(() => updateTaskEffect(effect.id, user, 'executing', { requireRunAwaitingCommit: true }), error => error.code === 'AGENT_TASK_RUN_NOT_COMMITTABLE');
        assert.equal(dispatched, false);
        await assert.rejects(() => softDeleteAgentRun(runId, user), error => error.code === 'AGENT_RUN_UNRESOLVED_EFFECTS');
        // 模拟旧版本曾隐藏记录，底层效果申请仍必须拒绝。
        await execute('UPDATE agent_runs SET deleted_at = NOW() WHERE id = ?', [runId]);
        await assert.rejects(() => updateTaskEffect(effect.id, user, 'executing'), error => error.code === 'AGENT_TASK_RUN_NOT_COMMITTABLE');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('hiding a cancelled run cannot race a new workspace preview into execution', async () => {
    const user = await queryOne('SELECT id, username, role FROM users ORDER BY id LIMIT 1');
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const runId = `delete-stage-race-${process.pid}-${Date.now()}-${attempt}`;
        await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, '删除竞争测试', '测试删除与暂存', 'cancelled', '{}', NOW(), NOW())", [runId, user.id]);
        try {
            const tx = await createTaskTransaction({ run: { id: runId, goal: '测试删除与暂存' }, user });
            await transitionTaskTransaction(tx.id, user, 'executing');
            const results = await Promise.allSettled([
                softDeleteAgentRun(runId, user),
                stageTaskEffect(tx.id, user, { effectType: 'workspace.patch', resourceKeys: [], idempotencyKey: `${runId}:patch`, commitMode: 'preview', compensation: { mode: 'manual' } })
            ]);
            assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
            const failed = results.find(item => item.status === 'rejected');
            assert.ok(['AGENT_TASK_RUN_NOT_COMMITTABLE', 'AGENT_RUN_UNRESOLVED_EFFECTS'].includes(failed.reason.code));
            const stored = await queryOne('SELECT deleted_at FROM agent_runs WHERE id = ?', [runId]);
            const effects = await queryOne('SELECT COUNT(*) AS count FROM agent_task_effects WHERE transaction_id = ?', [tx.id]);
            assert.equal(Boolean(stored.deleted_at) && Number(effects.count) > 0, false);
        } finally {
            await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        }
    }
});
