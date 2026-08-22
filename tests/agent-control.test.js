const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const {
    acknowledgeAgentControlMessage,
    claimAgentControlMessages,
    listAgentControlMessages,
    sendAgentControlMessage
} = require('../server/services/agent-control');
const { cancelAgentRun } = require('../server/services/agent-runtime');

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

        const acknowledged = await acknowledgeAgentControlMessage(created.message_id, user, childId);
        assert.equal(acknowledged.status, 'acknowledged');
        assert.equal((await listAgentControlMessages(childId, user, { status: 'acknowledged' })).length, 1);

        await assert.rejects(
            () => sendAgentControlMessage({ user: otherUser, fromRunId: otherRunId, toRunId: childId, payload: { text: 'no' } }),
            error => error.code === 'AGENT_CONTROL_TARGET_NOT_FOUND'
        );
    } finally {
        await execute('DELETE FROM agent_control_messages WHERE from_run_id IN (?, ?) OR to_run_id IN (?, ?)', [parentId, childId, parentId, childId]);
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?, ?)', [parentId, childId, otherRunId]);
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
