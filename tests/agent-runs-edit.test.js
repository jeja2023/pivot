const test = require('node:test');
const assert = require('node:assert/strict');
const { sql } = require('../server/db/statements');
const {
    updateAgentRunTitleAndGoal,
    getRunForUser
} = require('../server/repositories/agent-runs');
const {
    updateAgentRunTitleAndGoalForUser
} = require('../server/services/agent-runs');

test('updateAgentRunTitleAndGoal modifies title and goal for a user run', () => {
    const runId = 'test-run-edit-001';
    const userId = 9991;
    sql('DELETE FROM agent_runs WHERE id = ?').run(runId);
    sql('DELETE FROM users WHERE id = ?').run(userId);
    sql(`
        INSERT INTO users (id, username, password_hash, role)
        VALUES (?, 'test_edit_user', 'hash', 'user')
    `).run(userId);
    sql(`
        INSERT INTO agent_runs (id, user_id, title, goal, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(runId, userId, '初始标题', '初始目标描述');

    const updated = updateAgentRunTitleAndGoal(runId, userId, {
        title: '新标题名称',
        goal: '详细更新后的任务目标与分析需求'
    });

    assert.ok(updated);
    assert.equal(updated.id, runId);
    assert.equal(updated.title, '新标题名称');
    assert.equal(updated.goal, '详细更新后的任务目标与分析需求');

    const saved = getRunForUser(runId, userId);
    assert.equal(saved.title, '新标题名称');
    assert.equal(saved.goal, '详细更新后的任务目标与分析需求');

    const wrongUserResult = updateAgentRunTitleAndGoal(runId, 8888, { title: '非法黑客修改' });
    assert.equal(wrongUserResult, null);

    const userObj = { id: userId };
    const serviceUpdated = updateAgentRunTitleAndGoalForUser(runId, userObj, {
        title: '二次修改标题'
    });
    assert.equal(serviceUpdated.title, '二次修改标题');
    assert.equal(serviceUpdated.goal, '详细更新后的任务目标与分析需求');

    sql('DELETE FROM agent_runs WHERE id = ?').run(runId);
    sql('DELETE FROM users WHERE id = ?').run(userId);
});
