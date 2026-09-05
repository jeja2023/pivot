const assert = require('node:assert/strict');
const test = require('node:test');
const { queryOne, execute } = require('../server/db/client');
const { claimAgentGoal } = require('../server/services/agent-goals');

test('持续目标调度租约在并发实例间只允许一个 claim，过期后可接管', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const goalId = `goal-lease-test-${process.pid}-${Date.now()}`;
    const now = '2000-01-01 00:00:00';
    await execute(`
        INSERT INTO agent_goals (
            id, user_id, title, goal, status, trigger_spec, authorization_spec,
            budget_spec, next_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, '{}', '{}', ?, ?, ?)
    `, [goalId, user.id, '租约测试目标', '验证多实例调度租约', '{"type":"timer","frequency":"daily"}', now, now, now]);

    try {
        const claims = await Promise.all([
            claimAgentGoal(goalId, 'lease-worker-a'),
            claimAgentGoal(goalId, 'lease-worker-b')
        ]);
        assert.equal(claims.filter(Boolean).length, 1);
        const firstOwner = claims.find(Boolean);
        const claimed = await queryOne('SELECT claim_token, claim_expires_at FROM agent_goals WHERE id = ?', [goalId]);
        assert.equal(claimed.claim_token, firstOwner);
        assert.ok(claimed.claim_expires_at);

        await execute('UPDATE agent_goals SET claim_expires_at = ? WHERE id = ?', [now, goalId]);
        assert.equal(await claimAgentGoal(goalId, 'lease-worker-c'), 'lease-worker-c');

        const replaced = await queryOne('SELECT claim_token FROM agent_goals WHERE id = ?', [goalId]);
        assert.equal(replaced.claim_token, 'lease-worker-c');
    } finally {
        await execute('DELETE FROM agent_goals WHERE id = ?', [goalId]);
    }
});
