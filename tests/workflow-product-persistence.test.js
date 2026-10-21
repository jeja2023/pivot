const test = require('node:test');
const assert = require('node:assert/strict');
const { queryOne, execute } = require('../server/db/client');
const drafts = require('../server/services/workflow-editor-experience');
const repository = require('../server/repositories/workflow-editor-drafts');
const { createAgentWorkflow, updateAgentWorkflow } = require('../server/services/agent-workflows');
const { publishWorkflowRelease } = require('../server/services/agent-releases');

async function user(suffix) {
    const row = await queryOne("INSERT INTO users (username,password_hash,nickname,role,status,created_at) VALUES (?,'hash','工作流测试','user','active',NOW()) RETURNING id", [`workflow_product_${suffix}_${Math.random().toString(36).slice(2,8)}`]);
    return { id: row.id, role: 'user', unit: '' };
}

test('未完成草稿独立持久化、按账号隔离，修订冲突保持原文', async () => {
    const owner = await user('draft'); const stranger = await user('stranger');
    try {
        const initial = await drafts.saveDraft(owner, 'unfinished', { specText: '{"nodes":[{"tool":""}]}', name: '未完成', expectedRevision: 0 });
        assert.equal(initial.revision, 1);
        assert.equal((await drafts.getDraft(owner, 'unfinished')).spec_text, '{"nodes":[{"tool":""}]}');
        assert.equal(await drafts.getDraft(stranger, 'unfinished'), null);
        await assert.rejects(drafts.saveDraft(owner, 'unfinished', { specText: '{}', expectedRevision: 0 }), error => error.code === 'WORKFLOW_DRAFT_CONFLICT');
        assert.equal((await drafts.getDraft(owner, 'unfinished')).revision, 1);
        const results = await Promise.allSettled([drafts.saveDraft(owner, 'unfinished', { specText: '未完成JSON也保留', expectedRevision: 1 }), drafts.saveDraft(owner, 'unfinished', { specText: '另一个窗口', expectedRevision: 1 })]);
        assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
        assert.equal(results.filter(item => item.status === 'rejected')[0].reason.code, 'WORKFLOW_DRAFT_CONFLICT');
        await assert.rejects(drafts.saveDraft(owner, '../outside', { specText: '{}', expectedRevision: 0 }), /标识无效/);
        await assert.rejects(drafts.saveDraft(owner, 'invalid', { workflowId: 'oops', specText: '{}', expectedRevision: 0 }), /标识无效/);
    } finally { await execute('DELETE FROM users WHERE id IN (?, ?)', [owner.id, stranger.id]); }
});

test('草稿不改变发布版，双击创建以编辑草稿身份去重', async () => {
    const owner = await user('create'); let workflow;
    try {
        await drafts.saveDraft(owner, 'new-idempotent', { specText: '{}', name: '创建去重', expectedRevision: 0 });
        const body = { name: '发布参数', editorDraftKey: 'new-idempotent', dagSpec: { nodes: [{ id: 'input', tool: 'workflow.input', input: { name: 'old', type: 'text', required: true } }, { id: 'out', tool: 'workflow.output', input: { name: 'result', value: '{{inputs.old}}' }, dependsOn: ['input'] }] } };
        const created = await Promise.all([createAgentWorkflow(owner, body), createAgentWorkflow(owner, body)]);
        workflow = created[0]; assert.equal(created[1].id, workflow.id);
        await publishWorkflowRelease(workflow.id, owner, { version: 'current' });
        const original = await drafts.runContext(owner, workflow.id);
        await drafts.saveDraft(owner, `workflow-${workflow.id}`, { workflowId: workflow.id, specText: '还未完成', expectedRevision: 0 });
        await updateAgentWorkflow(workflow.id, owner, { ...body, expectedVersion: workflow.current_version, dagSpec: { nodes: [{ id: 'input', tool: 'workflow.input', input: { name: 'new', type: 'text', required: true } }, { id: 'out', tool: 'workflow.output', input: { name: 'result', value: '{{inputs.new}}' }, dependsOn: ['input'] }] } });
        const published = await drafts.runContext(owner, workflow.id);
        assert.equal(published.versionId, original.versionId);
        assert.equal(published.dagSpec.nodes.find(node => node.id === 'input').input.name, 'old');
    } finally {
        if (workflow) await execute('DELETE FROM agent_workflows WHERE id = ?', [workflow.id]);
        await execute('DELETE FROM users WHERE id = ?', [owner.id]);
    }
});

test('只读共享接收者不能改草稿，收藏和最近使用记录仅属于本人', async () => {
    const owner = await user('owner'); const receiver = await user('receiver'); let workflow;
    try {
        workflow = await createAgentWorkflow(owner, { name: '共享只读', scope: 'shared', allowedUserIds: [receiver.id], dagSpec: { nodes: [{ id: 'out', tool: 'workflow.output', input: { name: 'result', value: 'ok' } }] } });
        await publishWorkflowRelease(workflow.id, owner, { version: 'current' });
        await assert.rejects(drafts.saveDraft(receiver, 'forbidden', { workflowId: workflow.id, specText: '{}', expectedRevision: 0 }), error => error.status === 403);
        await drafts.preference(receiver, workflow.id, { favorite: true, used: true });
        assert.equal((await repository.preferences(receiver.id))[0].favorite, true);
        assert.equal((await repository.preferences(owner.id)).length, 0);
        const context = await drafts.runContext(receiver, workflow.id);
        assert.equal(context.version, 1);
        assert.equal(context.workflow.is_owner, false);
    } finally {
        if (workflow) await execute('DELETE FROM agent_workflows WHERE id = ?', [workflow.id]);
        await execute('DELETE FROM users WHERE id IN (?, ?)', [owner.id, receiver.id]);
    }
});

test('没有预先保存的编辑键也能并发创建去重，后续草稿保存保持工作流关联', async () => {
    const owner = await user('direct'); let workflow;
    try {
        const body = { name: '直接创建', editorDraftKey: 'new-direct', dagSpec: { nodes: [{ id: 'out', tool: 'workflow.output', input: { name: 'result', value: 'ok' } }] } };
        const [first, second] = await Promise.all([createAgentWorkflow(owner, body), createAgentWorkflow(owner, body)]);
        workflow = first; assert.equal(second.id, first.id);
        const draft = await drafts.getDraft(owner, 'new-direct'); assert.equal(Number(draft.workflow_id), Number(first.id));
        await drafts.saveDraft(owner, 'new-direct', { specText: '{"nodes":[', name: '未完成的关联草稿', expectedRevision: draft.revision });
        assert.equal(Number((await drafts.getDraft(owner, 'new-direct')).workflow_id), Number(first.id));
    } finally { if (workflow) await execute('DELETE FROM agent_workflows WHERE id = ?', [workflow.id]); await execute('DELETE FROM users WHERE id = ?', [owner.id]); }
});
