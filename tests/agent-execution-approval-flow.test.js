'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { queryOne, execute } = require('../server/db/client');
const { approvalInputHash, approvalInputMatches, approvalExpiryMs, resolveApprovalKey, approvedOperationKey, completeApprovalInvocation } = require('../server/services/agent-approval-grants');
const { createToolOrchestrator } = require('../server/services/agent-tool-orchestrator');
const { beginAgentToolCheckpoint, completeAgentToolCheckpoint } = require('../server/services/agent-checkpoints');
const { createAgentRunFactory } = require('../server/services/agent-runtime/run-creation');

function approvedRun() {
    const input = { destination: 'authorized', payload: { b: 2, a: 1 } };
    const grant = { tool: 'example.send', key: 'run:4:example.send', inputHash: approvalInputHash(input), hashVersion: 2, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    return { input, grant, run: { id: 'run', metadata: { approvalGrants: [grant], resumeContext: {
        approvedTool: grant.tool, approvedInputHash: grant.inputHash, approvedApprovalKey: grant.key, approvalHashVersion: 2
    } } } };
}

test('approval resume reuses the approved operation key after the planner step changes, but changed parameters require a fresh approval', () => {
    const { run, grant, input } = approvedRun();
    assert.equal(resolveApprovalKey(run, grant.tool, input, 'run:7:example.send'), grant.key);
    assert.equal(resolveApprovalKey(run, grant.tool, { ...input, destination: 'other' }, 'new-key'), 'new-key');
    const reordered = { payload: { a: 1, b: 2 }, destination: 'authorized' };
    assert.equal(approvalInputHash(reordered), grant.inputHash);
    assert.equal(approvedOperationKey(run, grant.tool, grant.key, reordered), approvedOperationKey(run, grant.tool, grant.key, input));
    grant.consumedAt = new Date().toISOString();
    assert.equal(resolveApprovalKey(run, grant.tool, input, 'next-key'), 'next-key');
});

test('approval expiry interprets database timestamps as Beijing time and supports the previous digest format', () => {
    assert.equal(approvalExpiryMs('2026-10-23 15:00:00'), Date.parse('2026-10-23T07:00:00Z'));
    assert.equal(approvalExpiryMs('invalid'), NaN);
    const input = { b: 2, a: 1 };
    const legacy = require('node:crypto').createHash('sha256').update(JSON.stringify(input)).digest('hex');
    assert.equal(approvalInputMatches({ inputHash: legacy, hashVersion: 1 }, input), true);
    assert.equal(approvalInputMatches({ inputHash: legacy, hashVersion: 2 }, input), false);
});

test('discovery metadata is rebuilt rather than replaying a checkpoint that cannot restore discovery state', async () => {
    let checkpoints = 0;
    let invocations = 0;
    const orchestrator = createToolOrchestrator({
        enforceToolPolicy: ({ input }) => ({ decision: 'allow', input }), beginAgentToolCheckpoint: async () => { checkpoints += 1; return { replay: true, output: 'old' }; },
        completeAgentToolCheckpoint: async () => true, recordAgentEvent: async () => {}, issueToolExecutionGrant: () => null,
        stageDeferredToolEffect: async () => null
    });
    const request = { run: { id: 'run' }, tool: { name: 'tools.describe', source: 'builtin' }, input: {}, context: { stepId: 'same-step' }, execute: async () => { invocations += 1; return 'current'; } };
    assert.equal(await orchestrator.execute(request), 'current');
    assert.equal(await orchestrator.execute(request), 'current');
    assert.equal(checkpoints, 0);
    assert.equal(invocations, 2);
});

test('approved operation checkpoints survive parameter key reordering and single-use grants are consumed after completion', async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const { run, grant, input } = approvedRun();
    run.id = `approved-operation-${process.pid}-${Date.now()}`;
    await execute("INSERT INTO agent_runs (id,user_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,'审批恢复','审批恢复验证','running',?::jsonb,NOW(),NOW())", [run.id, user.id, JSON.stringify(run.metadata)]);
    try {
        const operationKey = approvedOperationKey(run, grant.tool, grant.key, input);
        await beginAgentToolCheckpoint(run.id, { operationKey, toolName: grant.tool, input, idempotent: false, approvalGranted: true, user });
        await completeAgentToolCheckpoint(operationKey, { sent: true }, { user });
        const replay = await beginAgentToolCheckpoint(run.id, { operationKey, toolName: grant.tool, input: { payload: { a: 1, b: 2 }, destination: 'authorized' }, idempotent: false, approvalGranted: true, user });
        assert.equal(replay.replay, true);
        assert.deepEqual(replay.output, { sent: true });
        await completeApprovalInvocation(run, user, grant.tool, grant.key, input);
        assert.ok(run.metadata.approvalGrants[0].consumedAt);
        assert.equal(run.metadata.resumeContext.approvedTool, undefined);
        assert.equal(resolveApprovalKey(run, grant.tool, input, 'next-operation'), 'next-operation');
    } finally { await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]); }
});

test('a new run cannot accept or inherit caller-supplied approval grants', async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const model = await queryOne("INSERT INTO models (user_id,name,url,api_key,model_name,status,created_at) VALUES (?,?,'http://127.0.0.1:1/v1','','approval-audit','active',NOW()) RETURNING id", [user.id, `approval-audit-${suffix}`]);
    let run;
    try {
        const factory = createAgentRunFactory({ enqueueAgentRun() {} });
        run = await factory({ user, modelId: model.id, goal: '核验任务创建的审批边界', metadata: {
            autoPersonalSkill: false, approvalGrants: [{ tool: 'example.send', rememberForRun: true }], pendingApproval: { tool: 'example.send' },
            resumeContext: { approvedTool: 'example.send', approvedInputHash: 'fake', previousAnswer: '保留历史结果' }
        } });
        const metadata = typeof run.metadata === 'string' ? JSON.parse(run.metadata) : run.metadata;
        assert.equal(metadata.approvalGrants, undefined);
        assert.equal(metadata.pendingApproval, undefined);
        assert.equal(metadata.resumeContext.approvedTool, undefined);
        assert.equal(metadata.resumeContext.previousAnswer, '保留历史结果');
    } finally {
        if (run) await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
        await execute('DELETE FROM models WHERE id = ?', [model.id]);
    }
});
