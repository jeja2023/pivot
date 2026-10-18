'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertPreviewEffectsReady, deferredEffectForTool, executeCompensation, stageDeferredToolEffect, workspaceSnapshotForPreview } = require('../server/services/agent-task-effect-executor');

test('autonomous controlled effects fail closed when the task transaction is missing', async () => {
    await assert.rejects(() => stageDeferredToolEffect({
        tool: { name: 'workflow.notify' }, input: { bindingId: 'binding-test' }, context: { autonomous: true }
    }), error => error.code === 'AGENT_TASK_TRANSACTION_REQUIRED');
    assert.equal(await stageDeferredToolEffect({
        tool: { name: 'agent.http' }, input: { method: 'GET', url: 'https://example.com' }, context: { autonomous: true }
    }), null);
    assert.equal(await stageDeferredToolEffect({
        tool: { name: 'workflow.notify' }, input: { bindingId: 'binding-test' }, context: {}
    }), null);
});

test('workflow notification is deferred with binding-scoped idempotency instead of being sent during planning', () => {
    const effect = deferredEffectForTool({
        tool: { name: 'workflow.notify' },
        input: { bindingId: 'binding-123', body: '验收后再发送' },
        operationKey: 'run-1:step-1:workflow.notify:hash'
    });
    assert.deepEqual(effect, {
        effectType: 'workflow.notify',
        resourceKeys: ['channel-binding:binding-123'],
        idempotencyKey: 'run-1:step-1:workflow.notify:hash',
        commitMode: 'after_verify',
        compensation: { mode: 'none', instructions: '外部通知发送后无法可靠撤回；提交前请复核接收渠道和内容。' }
    });
});

test('only registered deferred effects are staged; ordinary reads remain immediate', () => {
    assert.equal(deferredEffectForTool({ tool: { name: 'rag.search' }, input: { query: 'x' }, operationKey: 'op' }), null);
    assert.equal(deferredEffectForTool({ tool: { name: 'workflow.notify' }, input: { body: 'missing binding' }, operationKey: 'op' }), null);
});

test('workspace mutations separate shadow-worktree previews from primary delivery commits', () => {
    const preview = deferredEffectForTool({
        tool: { name: 'mcp.0.workspace.patch' },
        input: { worktreeName: 'run-preview', changes: [{ path: 'src/app.js', content: 'export {};' }] },
        operationKey: 'run:patch'
    });
    assert.equal(preview.effectType, 'mcp.workspace.patch');
    assert.equal(preview.commitMode, 'preview');
    assert.ok(preview.resourceKeys.includes('workspace-worktree:run-preview'));
    assert.ok(preview.resourceKeys.includes('workspace-file:run-preview:src/app.js'));
    assert.equal(preview.compensation.mode, 'manual');

    const merge = deferredEffectForTool({
        tool: { name: 'mcp.0.workspace.git_merge' },
        input: { branch: 'codex/run-preview' },
        operationKey: 'run:merge'
    });
    assert.equal(merge.effectType, 'mcp.workspace.git_merge');
    assert.equal(merge.commitMode, 'after_verify');
    assert.deepEqual(merge.resourceKeys, ['workspace-primary']);
    assert.throws(
        () => deferredEffectForTool({
            tool: { name: 'mcp.0.workspace.patch' }, input: { changes: [{ path: 'src/app.js', content: 'unsafe' }] }, operationKey: 'run:unsafe'
        }),
        error => error.code === 'AGENT_WORKSPACE_SHADOW_REQUIRED'
    );
});

test('legacy automatic shadow-worktree removal is stopped for manual preservation', async () => {
    const result = await executeCompensation({ plan: { mode: 'automatic', action: 'remove_shadow_worktree' } }, {});
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'shadow_worktree_requires_manual_preservation');
});

test('external effects are blocked before execution when a preview is unfinished', () => {
    assert.throws(() => assertPreviewEffectsReady([{ commitMode: 'preview', status: 'executing' }, { commitMode: 'after_verify', status: 'staged' }]), error => error.code === 'AGENT_TASK_PREVIEW_NOT_READY');
    assert.doesNotThrow(() => assertPreviewEffectsReady([{ commitMode: 'preview', status: 'staged' }]));
});

test('HTTP writes are deferred by origin while GET remains a read observation', () => {
    const write = deferredEffectForTool({
        tool: { name: 'agent.http' },
        input: { method: 'PATCH', url: 'https://api.example.com/v1/items/42', body: { state: 'done' } },
        operationKey: 'run:http-write'
    });
    assert.equal(write.effectType, 'agent.http');
    assert.equal(write.commitMode, 'after_verify');
    assert.deepEqual(write.resourceKeys, ['http-origin:https://api.example.com']);
    assert.equal(deferredEffectForTool({
        tool: { name: 'agent.http' }, input: { method: 'GET', url: 'https://api.example.com/v1/items/42' }, operationKey: 'run:http-read'
    }), null);
});

test('workspace preview requires a managed shadow-worktree snapshot for recovery', () => {
    const effect = {
        id: 'effect-1', effectType: 'mcp.workspace.patch', commitMode: 'preview',
        request: { input: { worktreeName: 'preview-one' } }
    };
    assert.deepEqual(workspaceSnapshotForPreview(effect, {
        worktreeName: 'preview-one', workspace: { branch: 'codex/preview-one', head: 'a'.repeat(40), revision: 'b'.repeat(64) }
    }), {
        worktreeName: 'preview-one', branch: 'codex/preview-one', head: 'a'.repeat(40), revision: 'b'.repeat(64), effectId: 'effect-1'
    });
    assert.throws(
        () => workspaceSnapshotForPreview(effect, { workspace: {} }),
        error => error.code === 'AGENT_WORKSPACE_SNAPSHOT_REQUIRED'
    );
    const recoverable = workspaceSnapshotForPreview(effect, {
        worktreeName: 'preview-one', workspace: { branch: 'codex/preview-one', head: 'a'.repeat(40), revision: 'b'.repeat(64) },
        recoverySnapshot: { archiveDigest: 'c'.repeat(64), restoreHandle: `local-recovery:${'c'.repeat(64)}` }
    });
    assert.equal(recoverable.archiveDigest, 'c'.repeat(64));
    assert.equal(recoverable.restoreHandle, `local-recovery:${'c'.repeat(64)}`);
});
