'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { queryOne, execute } = require('../server/db/client');
const { createAgentWorkflow, updateAgentWorkflow } = require('../server/services/agent-workflows');
const { publishWorkflowRelease } = require('../server/services/agent-releases');
const {
    approveWorkflowSourceReview,
    attachWorkflowSource,
    updateMemoryStatus
} = require('../server/services/long-term-memory');

const FINGERPRINT_SECRET = 'pivot-workflow-memory-source-test-secret-012345678901234';

function dag(value) {
    return { nodes: [{ id: 'output', tool: 'workflow.output', input: { name: 'answer', value } }] };
}

test('已关联的工作流记忆会在发布新版本时隔离，并只能以当前发布版本完成复核', async () => {
    const previous = process.env.PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET;
    process.env.PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET = FINGERPRINT_SECRET;
    const user = await queryOne('SELECT id, username, role, unit FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    let workflowId;
    let memoryId;
    try {
        const workflow = await createAgentWorkflow(user, {
            name: `记忆来源工作流-${suffix}`, description: '来源失效回归', dagSpec: dag('初始版本'), note: '初始版本'
        });
        workflowId = Number(workflow.id);
        const initialRelease = await publishWorkflowRelease(workflowId, user, { version: 'current' });
        assert.equal(initialRelease.status, 'published');
        const memory = await queryOne(`
            INSERT INTO memories (user_id, type, content, origin, status, created_at, updated_at)
            VALUES (?, 'fact', ?, 'explicit', 'active', NOW(), NOW()) RETURNING id
        `, [user.id, `工作流来源隔离回归-${suffix}`]);
        memoryId = Number(memory.id);
        assert.ok(Number.isSafeInteger(memoryId) && memoryId > 0);
        const source = await attachWorkflowSource(user.id, memoryId, workflowId);
        assert.equal(source.sourceRef, `agent_workflow:${workflowId}`);

        await updateAgentWorkflow(workflowId, user, {
            name: `记忆来源工作流-${suffix}`, description: '来源失效回归', dagSpec: dag('更新版本'), note: '更新版本'
        });
        const updatedRelease = await publishWorkflowRelease(workflowId, user, { version: 'current' });
        assert.equal(updatedRelease.status, 'published');
        assert.equal((await queryOne('SELECT status FROM memories WHERE id = ?', [memoryId])).status, 'review_required');
        await assert.rejects(
            () => updateMemoryStatus(user.id, memoryId, 'active'),
            error => error.code === 'MEMORY_SOURCE_REVIEW_REQUIRED'
        );
        const reviewed = await approveWorkflowSourceReview(user.id, memoryId, `agent_workflow:${workflowId}`);
        assert.equal(reviewed.activated, true);
        assert.equal((await queryOne('SELECT status FROM memories WHERE id = ?', [memoryId])).status, 'active');
    } finally {
        if (memoryId) await execute('DELETE FROM memories WHERE id = ?', [memoryId]);
        if (workflowId) {
            await execute('DELETE FROM agent_workflow_releases WHERE workflow_id = ?', [workflowId]);
            await execute('UPDATE agent_workflows SET deleted_at = NOW(), published_version_id = NULL WHERE id = ?', [workflowId]);
        }
        if (previous === undefined) delete process.env.PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET;
        else process.env.PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET = previous;
    }
});
