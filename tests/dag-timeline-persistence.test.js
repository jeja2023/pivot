const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { upsertDagNode } = require('../server/services/agent-dag-runtime');

test('节点完成时保留运行开始时间，显式重置为待调度时清空旧时间', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `timeline-persist-${process.pid}-${Date.now()}`;
    await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, '甘特图时间测试', '保存节点起止时间', 'running', '{}', NOW(), NOW())", [runId, user.id]);
    const node = { id: 'node', title: '测试节点', tool: 'workflow.template' };
    try {
        await upsertDagNode(runId, node, { status: 'running', startedAt: '2026-10-19 10:00:00' });
        await upsertDagNode(runId, node, { status: 'completed', durationMs: 2000, completedAt: '2026-10-19 10:00:02' });
        const saved = await queryOne('SELECT started_at, completed_at, duration_ms FROM agent_dag_nodes WHERE run_id = ?', [runId]);
        assert.equal(saved.started_at, '2026-10-19 10:00:00');
        assert.equal(saved.completed_at, '2026-10-19 10:00:02');
        assert.equal(saved.duration_ms, 2000);
        await upsertDagNode(runId, node, { status: 'pending' });
        assert.equal((await queryOne('SELECT started_at FROM agent_dag_nodes WHERE run_id = ?', [runId])).started_at, null);
    } finally { await execute('DELETE FROM agent_runs WHERE id = ?', [runId]); }
});
