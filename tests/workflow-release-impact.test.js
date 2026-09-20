const test = require('node:test');
const assert = require('node:assert/strict');
const { queryOne, execute } = require('../server/db/client');
const { createAgentWorkflow } = require('../server/services/agent-workflows');
const { getWorkflowReleaseImpact } = require('../server/services/agent-releases');

test('发布影响清单汇总当前版本的副作用、网络、凭据和子工作流依赖', async () => {
    const suffix = Date.now().toString(36);
    const userRow = await queryOne(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', ?, '研发部', 'user', 'active', NOW() AT TIME ZONE 'Asia/Shanghai')
        RETURNING id
    `, [`workflow_impact_${suffix}`, '影响清单测试']);
    const user = { id: userRow.id, role: 'user', unit: '研发部' };
    let workflow = null;
    try {
        workflow = await createAgentWorkflow(user, {
            name: '影响清单测试',
            dagSpec: {
                nodes: [
                    { id: 'fetch', title: '读取 CRM', tool: 'agent.http', input: { url: 'https://crm.example.test/orders', credentialSecret: 'CRM_API' }, dependsOn: [] },
                    { id: 'iterate', title: '逐项处理', tool: 'workflow.iteration', input: { workflowId: 77, version: '3', items: [] }, dependsOn: ['fetch'] }
                ]
            }
        });
        const impact = await getWorkflowReleaseImpact(workflow.id, user, { version: 'current' });
        assert.equal(impact.workflowId, workflow.id);
        assert.equal(impact.summary.networkCount, 1);
        assert.equal(impact.summary.subworkflowCount, 1);
        assert.equal(impact.sideEffects.some(item => item.tool === 'agent.http'), true);
        assert.equal(impact.dependencies.credentials.some(item => item.source === 'CRM_API'), true);
        assert.equal(impact.subworkflows[0].workflowId, 77);
    } finally {
        if (workflow) await execute('DELETE FROM agent_workflows WHERE id = ?', [workflow.id]);
        await execute('DELETE FROM users WHERE id = ?', [user.id]);
    }
});
