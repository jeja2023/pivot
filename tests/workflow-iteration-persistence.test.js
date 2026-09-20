const test = require('node:test');
const assert = require('node:assert/strict');
const { queryOne, execute } = require('../server/db/client');
const { listWorkflowIterationItems } = require('../server/repositories/agent-runs');

test('迭代项持久化保留输入摘要、固定版本与可恢复终态结果', async () => {
    const suffix = Date.now().toString(36);
    const user = await queryOne(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, 'hash', '迭代恢复用户', '研发部', 'user', 'active', NOW() AT TIME ZONE 'Asia/Shanghai') RETURNING id`, [`iteration_persist_${suffix}`]);
    const runId = `iteration-persist-${suffix}`;
    try {
        await execute(`INSERT INTO agent_runs (id, user_id, goal, run_mode, status, created_at, updated_at) VALUES (?, ?, '迭代恢复', 'dag', 'running', NOW() AT TIME ZONE 'Asia/Shanghai', NOW() AT TIME ZONE 'Asia/Shanghai')`, [runId, user.id]);
        await execute(`INSERT INTO agent_workflow_iteration_items (run_id, iteration_key, input_index, item_id, input_digest, workflow_id, workflow_version_id, invocation_id, status, input_json, result_json, created_at, updated_at, completed_at) VALUES (?, 'iteration:iterate:10', 0, 'item-abc', ?, 10, 70, 'invocation-1', 'completed', ?, ?, NOW() AT TIME ZONE 'Asia/Shanghai', NOW() AT TIME ZONE 'Asia/Shanghai', NOW() AT TIME ZONE 'Asia/Shanghai')`, [runId, 'a'.repeat(64), JSON.stringify({ item: { id: 1 } }), JSON.stringify({ itemId: 'item-abc', inputIndex: 0, status: 'completed', value: { text: '完成' } })]);
        const items = await listWorkflowIterationItems(runId);
        assert.equal(items.length, 1);
        assert.equal(items[0].input_digest, 'a'.repeat(64));
        assert.equal(items[0].workflow_version_id, 70);
        assert.deepEqual(items[0].result_json.value, { text: '完成' });
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        await execute('DELETE FROM users WHERE id = ?', [user.id]);
    }
});
