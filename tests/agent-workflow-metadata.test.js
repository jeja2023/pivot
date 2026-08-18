const assert = require('node:assert/strict');
const test = require('node:test');
const { sql } = require('../server/db/statements');
const {
    createAgentWorkflow,
    updateAgentWorkflowMetadata
} = require('../server/services/agent-workflows');

test('工作流基本信息可独立修改且不会产生新的编排版本', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = sql(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', ?, '研发部', 'user', 'active', datetime('now', '+8 hours'))
    `).run(`workflow_meta_${suffix}`, '工作流信息测试');
    const user = { id: Number(userInfo.lastInsertRowid), role: 'user', unit: '研发部' };
    let workflow = null;

    try {
        workflow = await createAgentWorkflow(user, {
            name: '原工作流',
            description: '原简介',
            dagSpec: {
                nodes: [{ id: 'output', title: '输出', tool: 'workflow.output', input: { name: 'result', value: 'ok' } }]
            }
        });
        const versionCountBefore = sql('SELECT COUNT(*) AS count FROM agent_workflow_versions WHERE workflow_id = ?')
            .get(workflow.id).count;

        const updated = await updateAgentWorkflowMetadata(workflow.id, user, {
            name: '新工作流名称',
            description: '新的工作流简介'
        });
        const versionCountAfter = sql('SELECT COUNT(*) AS count FROM agent_workflow_versions WHERE workflow_id = ?')
            .get(workflow.id).count;

        assert.equal(updated.name, '新工作流名称');
        assert.equal(updated.description, '新的工作流简介');
        assert.equal(versionCountAfter, versionCountBefore);
        assert.equal(await updateAgentWorkflowMetadata(workflow.id, { id: user.id + 1 }, { name: '越权修改' }), null);
    } finally {
        if (workflow) sql('DELETE FROM agent_workflows WHERE id = ?').run(workflow.id);
        sql('DELETE FROM users WHERE id = ?').run(user.id);
    }
});
