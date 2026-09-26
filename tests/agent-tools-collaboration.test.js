'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const {
    executeAgentCancel,
    executeAgentJoin,
    executeAgentMessage,
    executeAgentSpawn,
    executeAgentWait
} = require('../server/services/agent-tools-collaboration');

test('agent spawn inherits parent controls and cannot widen an allowlist', async () => {
    const created = [];
    const parent = {
        id: 'parent-spawn', user_id: 5, model_id: 9, run_mode: 'standard', max_steps: 20,
        tool_policy: 'all', tool_allowlist: JSON.stringify(['rag.search']), approval_policy: 'safe_mcp_auto', network_policy: '{}'
    };
    const result = await executeAgentSpawn({
        goal: '检索资料',
        toolAllowlist: ['rag.search', 'agent.http'],
        maxSteps: 5
    }, { id: 5 }, {
        run: parent,
        collaborationRuntime: {
            createAgentRun: async input => { created.push(input); return { id: 'child-spawn', title: input.title, status: 'queued' }; }
        }
    });
    assert.equal(result.children[0].id, 'child-spawn');
    assert.deepEqual(created[0].toolAllowlist, ['rag.search']);
    assert.equal(created[0].parentRunId, parent.id);
    assert.equal(created[0].approvalPolicy, parent.approval_policy);
});

test('agent wait, message, join, and cancel are restricted to direct children', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const parent = { id: `collab-parent-${suffix}`, user_id: user.id };
    const child = { id: `collab-child-${suffix}`, user_id: user.id };
    const other = { id: `collab-other-${suffix}`, user_id: user.id };
    try {
        for (const row of [parent, child, other]) {
            await execute(`
                INSERT INTO agent_runs (id, user_id, title, goal, status, parent_run_id, metadata, created_at, updated_at, completed_at)
                VALUES (?, ?, ?, ?, ?, ?, '{}', NOW(), NOW(), NOW())
            `, [row.id, user.id, row.id, row.id, row.id === child.id ? 'completed' : 'queued', row.id === child.id ? parent.id : null]);
        }
        const context = {
            run: parent,
            collaborationRuntime: { cancelAgentRun: async id => ({ id, status: 'cancelled' }) }
        };
        const waited = await executeAgentWait({}, user, context);
        assert.equal(waited.complete, true);
        assert.equal(waited.children.length, 1);
        const joined = await executeAgentJoin({}, user, context);
        assert.equal(joined.complete, true);
        const messaged = await executeAgentMessage({ childRunId: child.id, message: '补充证据' }, user, context);
        assert.ok(messaged.messageId);
        const cancelled = await executeAgentCancel({ childRunId: child.id }, user, context);
        assert.equal(cancelled.status, 'cancelled');
        await assert.rejects(
            () => executeAgentCancel({ childRunId: other.id }, user, context),
            error => error.code === 'AGENT_CHILD_NOT_FOUND'
        );
    } finally {
        await execute('DELETE FROM agent_control_messages WHERE from_run_id = ? OR to_run_id = ?', [parent.id, child.id]);
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?, ?)', [parent.id, child.id, other.id]);
    }
});

