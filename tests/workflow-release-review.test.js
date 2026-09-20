const test = require('node:test');
const assert = require('node:assert/strict');
const { queryOne, execute } = require('../server/db/client');
const { createAgentWorkflow } = require('../server/services/agent-workflows');
const { reviewWorkflowRelease } = require('../server/services/agent-releases');

test('同一租户管理员可审阅共享工作流发布，所有者和其他角色不能越权审阅', async () => {
    const suffix = Date.now().toString(36);
    const ownerRow = await queryOne(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', '发布所有者', '研发部', 'user', 'active', NOW() AT TIME ZONE 'Asia/Shanghai')
        RETURNING id
    `, [`release_owner_${suffix}`]);
    const reviewerRow = await queryOne(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', '发布审阅员', '研发部', 'admin', 'active', NOW() AT TIME ZONE 'Asia/Shanghai')
        RETURNING id
    `, [`release_reviewer_${suffix}`]);
    const owner = { id: ownerRow.id, role: 'user', unit: '研发部' };
    const reviewer = { id: reviewerRow.id, role: 'admin', unit: '研发部' };
    let workflow = null;
    let releaseId = null;
    try {
        workflow = await createAgentWorkflow(owner, {
            name: '发布审阅工作流',
            dagSpec: { nodes: [{ id: 'output', tool: 'workflow.output', input: { name: 'answer', value: 'ok' } }] }
        });
        const release = await queryOne(`
            INSERT INTO agent_workflow_releases (
                workflow_id, workflow_version_id, tenant_id, rollout_scope, rollout_percent,
                target_user_ids, target_units, status, published_by, published_at, review_status
            ) VALUES (?, ?, 1, 'organization', 100, '[]', '[]', 'published', ?, NOW() AT TIME ZONE 'Asia/Shanghai', 'pending')
            RETURNING id
        `, [workflow.id, workflow.current_version_id, owner.id]);
        releaseId = release.id;
        await assert.rejects(
            () => reviewWorkflowRelease(releaseId, owner, { status: 'approved', note: '所有者不应自审。' }),
            error => error.code === 'WORKFLOW_RELEASE_REVIEW_FORBIDDEN'
        );
        const reviewed = await reviewWorkflowRelease(releaseId, reviewer, { status: 'changes_requested', note: '请补充外部写操作的回滚说明。' });
        assert.equal(reviewed.review_status, 'changes_requested');
        assert.equal(reviewed.reviewed_by, reviewer.id);
        assert.equal(reviewed.review_note, '请补充外部写操作的回滚说明。');
    } finally {
        if (releaseId) await execute('DELETE FROM agent_workflow_releases WHERE id = ?', [releaseId]);
        if (workflow) await execute('DELETE FROM agent_workflows WHERE id = ?', [workflow.id]);
        await execute("DELETE FROM agent_inbox_events WHERE event_key LIKE ?", [`workflow.release.review:%${releaseId || ''}%`]);
        await execute('DELETE FROM users WHERE id IN (?, ?)', [owner.id, reviewer.id]);
    }
});
