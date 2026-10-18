'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { recordCollaboratorCompletion } = require('../server/services/agent-collaboration');
const { claimAgentControlMessages, applyAgentControlMessages, acknowledgeAppliedAgentControlMessages, listAgentControlMessages } = require('../server/services/agent-control');
const { executeAgentJoin } = require('../server/services/agent-tools-collaboration');

test('Supervisor 在完成回执投递后重启不会重复投递子任务 Handoff', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const supervisorId = `supervisor-restart-${suffix}`;
    const childId = `child-restart-${suffix}`;
    const now = '2026-10-18 00:30:00';
    await execute(`
        INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
        VALUES (?, ?, 'supervisor', '汇合子任务', 'running', '{}', ?, ?)
    `, [supervisorId, user.id, now, now]);
    await execute(`
        INSERT INTO agent_runs (id, user_id, parent_run_id, title, goal, status, final_answer, metadata, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, 'child', '完成子任务', 'completed', '已完成并附带证据。', ?::jsonb, ?, ?, ?)
    `, [childId, user.id, supervisorId, JSON.stringify({ source: 'delegation', collaboration: { supervisorRunId: supervisorId, batchId: 'restart-test', taskIndex: 0, taskCount: 1, outputSchema: {} } }), now, now, now]);
    try {
        await recordCollaboratorCompletion(childId, 'completed');
        const first = await listAgentControlMessages(supervisorId, user, {});
        assert.equal(first.filter(item => item.payload?.kind === 'delegation_completion').length, 1);

        // 模拟发送成功后进程崩溃：元数据中的 completionNotified 尚未持久化。
        const child = await queryOne('SELECT metadata FROM agent_runs WHERE id = ?', [childId]);
        const metadata = typeof child.metadata === 'object' ? child.metadata : JSON.parse(child.metadata || '{}');
        await execute(`UPDATE agent_runs SET metadata = ?::jsonb WHERE id = ?`, [JSON.stringify({
            ...metadata,
            collaboration: { ...(metadata.collaboration || {}), completionNotified: false }
        }), childId]);
        await recordCollaboratorCompletion(childId, 'completed');
        const retried = await listAgentControlMessages(supervisorId, user, {});
        assert.equal(retried.filter(item => item.payload?.kind === 'delegation_completion').length, 1);
    } finally {
        await execute('DELETE FROM agent_control_messages WHERE from_run_id IN (?, ?) OR to_run_id IN (?, ?)', [supervisorId, childId, supervisorId, childId]);
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [supervisorId, childId]);
    }
});

test('Supervisor join blocks undelivered completion and accepts it only after delivery and durable application', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}-join`;
    const supervisorId = `supervisor-join-${suffix}`;
    const childId = `child-join-${suffix}`;
    const now = '2026-10-18 00:30:00';
    await execute(`
        INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
        VALUES (?, ?, 'supervisor', '汇合子任务', 'running', '{}', ?, ?)
    `, [supervisorId, user.id, now, now]);
    await execute(`
        INSERT INTO agent_runs (id, user_id, parent_run_id, title, goal, status, final_answer, metadata, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, 'child', '完成子任务', 'completed', '已完成并附带证据。', ?::jsonb, ?, ?, ?)
    `, [childId, user.id, supervisorId, JSON.stringify({ source: 'delegation', collaboration: { supervisorRunId: supervisorId, outputSchema: {} } }), now, now, now]);
    await execute(`
        INSERT INTO agent_verifications (id, run_id, user_id, contract, outcome_status, report, created_at, updated_at)
        VALUES (?, ?, ?, '{}'::jsonb, 'verified', '{}'::jsonb, ?, ?)
    `, [`verify-${suffix}`, childId, user.id, now, now]);
    const context = { run: { id: supervisorId, user_id: user.id } };
    try {
        await recordCollaboratorCompletion(childId, 'completed');
        const pending = await executeAgentJoin({}, user, context);
        assert.equal(pending.complete, true);
        assert.equal(pending.accepted, false);
        assert.equal(pending.results[0].handoffStatus, 'pending');
        const delivered = await claimAgentControlMessages(supervisorId, user);
        assert.equal(delivered.length, 1);
        assert.equal((await executeAgentJoin({}, user, context)).accepted, false, '仅领取消息不能视作已应用');
        const applied = await applyAgentControlMessages(supervisorId, user, delivered);
        assert.equal(applied.length, 1);
        // 模拟 Supervisor 在写入 applied 后、ACK 前崩溃：重启只补确认，不重复应用。
        assert.equal((await claimAgentControlMessages(supervisorId, user)).length, 0);
        await acknowledgeAppliedAgentControlMessages(supervisorId, user, applied);
        const joined = await executeAgentJoin({}, user, context);
        assert.equal(joined.accepted, true);
        assert.equal(joined.results[0].handoffStatus, 'acknowledged');
        await assert.rejects(() => executeAgentJoin({ childRunIds: [childId, 'missing-child'] }, user, context), error => error.code === 'AGENT_CHILD_NOT_FOUND');
    } finally {
        await execute('DELETE FROM agent_control_messages WHERE from_run_id IN (?, ?) OR to_run_id IN (?, ?)', [supervisorId, childId, supervisorId, childId]);
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [supervisorId, childId]);
    }
});

test('structured-output repair inherits the failed child run security boundaries', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}-repair`;
    const supervisorId = `supervisor-${suffix}`;
    const childId = `child-${suffix}`;
    const metadata = {
        source: 'delegation',
        collaboration: {
            supervisorRunId: supervisorId,
            outputSchema: { type: 'object', required: ['result'], properties: { result: { type: 'string' } } }
        }
    };
    await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, 'supervisor', '汇合', 'running', '{}'::jsonb, NOW(), NOW())", [supervisorId, user.id]);
    await execute(`INSERT INTO agent_runs (id, user_id, parent_run_id, title, goal, status, final_answer, metadata, run_mode, max_steps, max_token_budget, tool_policy, tool_allowlist, approval_policy, network_policy, timeout_ms, tool_timeout_ms, created_at, updated_at)
        VALUES (?, ?, ?, 'child', '输出结构化结果', 'completed', 'invalid JSON', ?::jsonb, 'audit', 5, 1000, 'all', ?::jsonb, 'approve_all_mcp', ?::jsonb, 45000, 8000, NOW(), NOW())`,
    [childId, user.id, supervisorId, JSON.stringify(metadata), JSON.stringify(['rag.search']), JSON.stringify({ enabled: false })]);
    let captured;
    try {
        const result = await recordCollaboratorCompletion(childId, 'completed', {
            createAgentRun: async input => { captured = input; return { id: `repair-${suffix}` }; }
        });
        assert.ok(result.repairRunId);
        assert.equal(captured.parentRunId, childId);
        assert.equal(captured.runMode, 'audit');
        assert.deepEqual(captured.toolAllowlist, ['rag.search']);
        assert.equal(captured.toolPolicy, 'builtin_only');
        assert.equal(captured.approvalPolicy, 'approve_all_mcp');
        assert.deepEqual(captured.networkPolicy, { enabled: false });
        assert.equal(captured.maxTokenBudget, 1000);
        assert.equal(captured.maxSteps, 3);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [supervisorId, childId]);
    }
});

test('Supervisor join records failed child as terminal but never accepts it as delivered work', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}-failed-child`;
    const supervisorId = `supervisor-${suffix}`;
    const childId = `child-${suffix}`;
    try {
        await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, 'supervisor', '汇合失败子任务', 'running', '{}'::jsonb, NOW(), NOW())", [supervisorId, user.id]);
        await execute("INSERT INTO agent_runs (id, user_id, parent_run_id, title, goal, status, final_answer, error_message, metadata, created_at, updated_at, completed_at) VALUES (?, ?, ?, 'failed child', '失败子任务', 'error', '', '工具执行失败', ?::jsonb, NOW(), NOW(), NOW())", [childId, user.id, supervisorId, JSON.stringify({ source: 'delegation', collaboration: { supervisorRunId: supervisorId } })]);
        const joined = await executeAgentJoin({}, user, { run: { id: supervisorId, user_id: user.id } });
        assert.equal(joined.complete, true);
        assert.equal(joined.accepted, false);
        assert.equal(joined.results[0].status, 'error');
        assert.match(joined.results[0].rejectionReason, /不能作为已验收交付/);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [supervisorId, childId]);
    }
});
