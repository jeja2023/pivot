'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { normalizeGoalInput, recordAgentGoalRunOutcome } = require('../server/services/agent-goals');

test('goal kinds normalize to a bounded product vocabulary', () => {
    assert.equal(normalizeGoalInput({ title: '监控', goal: '检查风险', triggerSpec: { type: 'manual' }, kind: 'monitor' }).kind, 'monitor');
    assert.equal(normalizeGoalInput({ title: '默认', goal: '执行任务', triggerSpec: { type: 'manual' }, kind: 'unknown' }).kind, 'scheduled_job');
});

test('completion-oriented goals stop after a verified successful outcome', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const goalId = `goal-kind-${suffix}`;
    const runId = `goal-kind-run-${suffix}`;
    try {
        await execute(`INSERT INTO agent_goals (id, user_id, title, goal, goal_kind, status, trigger_spec, authorization_spec, budget_spec, created_at, updated_at) VALUES (?, ?, '完成目标', '完成后停止', 'goal', 'active', '{"type":"manual"}', '{}', '{}', NOW(), NOW())`, [goalId, user.id]);
        await execute(`INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, 'goal run', 'goal run', 'completed', ?, NOW(), NOW())`, [runId, user.id, JSON.stringify({ goalId })]);
        await recordAgentGoalRunOutcome(runId, 'success');
        const goal = await queryOne('SELECT status, next_run_at FROM agent_goals WHERE id = ?', [goalId]);
        assert.equal(goal.status, 'completed');
        assert.equal(goal.next_run_at, null);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        await execute('DELETE FROM agent_goals WHERE id = ?', [goalId]);
    }
});
