const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ToolRegistry } = require('../server/services/agent-contracts');
const { DesktopAgentRuntime } = require('../desktop/agent-runtime');
const { diagnoseError, buildRecoveryPlan } = require('../server/services/agent-diagnosis');
const { validateNetworkPolicyUrl } = require('../server/services/agent-network-policy');

function makeRuntime() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-agent-acceptance-'));
    const registry = new ToolRegistry([
        {
            name: 'data.query',
            input_schema: { type: 'object', required: ['value'], properties: { value: { type: 'integer' } } },
            idempotent: true,
            handler: async input => ({ value: input.value, source: 'desktop' })
        },
        {
            name: 'records.export',
            input_schema: { type: 'object', required: ['value'], properties: { value: { type: 'integer' } } },
            side_effect: true,
            handler: async input => ({ exported: input.value })
        }
    ]);
    return { root, runtime: new DesktopAgentRuntime({ dbPath: path.join(root, 'state.db'), registry }) };
}

test('端云 Trace 联调可从桌面工具账本生成 Web DAG 草稿', async () => {
    const { root, runtime } = makeRuntime();
    try {
        const run = runtime.createRun({ goal: '查询并固化结果' });
        await runtime.execute(run.id, [{ tool: 'data.query', input: { value: 7 } }, { tool: 'records.export', input: { value: 7 }, operationKey: 'export-7' }], { approvalGranted: true });
        const draft = runtime.compileWorkflowDraft(run.id, { title: '端云联调草稿' });
        assert.equal(draft.draft, true);
        assert.equal(draft.title, '端云联调草稿');
        assert.equal(draft.nodes.length, 2);
        assert.equal(draft.nodes[1].sideEffect, true);
    } finally {
        runtime.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Crash Recovery 演练保留检查点并对未完成副作用调用重新审批', () => {
    const { root, runtime } = makeRuntime();
    try {
        const run = runtime.createRun({ goal: '副作用恢复演练' });
        runtime.store.transitionRun(run.id, 'planning');
        runtime.store.transitionRun(run.id, 'executing');
        runtime.store.beginTool({ runId: run.id, stepId: 'crash-step', operationKey: 'crash-export', toolName: 'records.export', input: { value: 9 }, inputHash: 'hash', idempotent: false, policyDecision: 'allow' });
        runtime.store.writeCheckpoint(run.id, 1, { phase: 'execute', value: 9 }, 'pending');
        const recovered = runtime.recover(run.id);
        assert.equal(recovered.requiresApproval, true);
        assert.equal(recovered.checkpoint.state.value, 9);
        assert.equal(recovered.run.status, 'waiting_approval');
    } finally {
        runtime.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Agent Runtime pressure and security probes remain bounded', async () => {
    const { root, runtime } = makeRuntime();
    try {
        const runs = Array.from({ length: 32 }, (_, value) => runtime.createRun({ goal: `压力任务 ${value}` }));
        const results = await Promise.all(runs.map((run, value) => runtime.execute(run.id, [{ tool: 'data.query', input: { value } }])));
        assert.equal(results.filter(result => result.status === 'completed').length, runs.length);
        assert.equal(runtime.store.listIncompleteRuns().length, 0);

        const diagnosis = diagnoseError(Object.assign(new Error('HTTP 502'), { code: 'EHTTP' }));
        const recovery = buildRecoveryPlan(diagnosis, 0);
        assert.equal(diagnosis.category, 'network');
        assert.equal(recovery.retryable, true);
        assert.throws(() => validateNetworkPolicyUrl('http://127.0.0.1:8080', { allowed_origins: ['http://127.0.0.1:8080'] }), /loopback/);
        assert.throws(() => validateNetworkPolicyUrl('https://example.com', {}, { requireAllowlist: true }), /Origin 白名单/);
    } finally {
        runtime.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
