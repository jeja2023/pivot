'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { getAgentQualityDashboard } = require('../server/services/agent-quality');

test('quality dashboard separates execution completion from verified outcomes and avoids empty 100%', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const dashboard = await getAgentQualityDashboard({ id: user.id, role: 'user' }, { days: 1 });
    assert.ok(Object.hasOwn(dashboard.runs, 'executionCompletionRate'));
    assert.ok(Object.hasOwn(dashboard.verification, 'verifiedRate'));
    if (dashboard.verification.total === 0) assert.equal(dashboard.verification.verifiedRate, null);
    if (dashboard.approvals.total === 0) assert.equal(dashboard.approvals.approvalRate, null);
});

test('quality dashboard scopes tool metrics to the requesting user', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const otherUsername = `quality_other_${suffix}`;
    const otherUser = await queryOne(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', ?, 'QA', 'user', 'active', NOW()) RETURNING id`, [otherUsername, otherUsername]);
    const ownRunId = `quality-own-${suffix}`;
    const otherRunId = `quality-other-${suffix}`;
    const ownCallId = `quality-own-call-${suffix}`;
    const otherCallId = `quality-other-call-${suffix}`;
    const before = await getAgentQualityDashboard({ id: user.id, role: 'user' }, { days: 1 });
    try {
        await execute(`INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, 'quality own', 'quality own', 'completed', '{}', NOW(), NOW()), (?, ?, 'quality other', 'quality other', 'completed', '{}', NOW(), NOW())`, [ownRunId, user.id, otherRunId, otherUser.id]);
        await execute(`INSERT INTO agent_tool_calls (id, run_id, step_id, tool_name, policy_decision, status, created_at) VALUES (?, ?, 'step-own', 'quality.read', 'allow', 'success', NOW()), (?, ?, 'step-other', 'quality.read', 'allow', 'success', NOW())`, [ownCallId, ownRunId, otherCallId, otherRunId]);
        const after = await getAgentQualityDashboard({ id: user.id, role: 'user' }, { days: 1 });
        assert.equal(after.tools.total, before.tools.total + 1);
        assert.equal(after.tools.success, before.tools.success + 1);
    } finally {
        await execute('DELETE FROM agent_tool_calls WHERE id IN (?, ?)', [ownCallId, otherCallId]);
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [ownRunId, otherRunId]);
        await execute('DELETE FROM users WHERE id = ?', [otherUser.id]);
    }
});
