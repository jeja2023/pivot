const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ToolRegistry } = require('../server/services/agent-contracts');
const { DesktopAgentRuntime } = require('../desktop/agent-runtime');

function makeRuntime() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-desktop-agent-'));
    const registry = new ToolRegistry([
        { name: 'filesystem.read', source: 'builtin', input_schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } }, handler: async input => ({ path: input.path, ok: true }) },
        { name: 'database.insert', source: 'builtin', risk_level: 5, side_effect: true, approval_required: true, input_schema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } }, handler: async input => ({ inserted: input.value }) }
    ]);
    return { root, runtime: new DesktopAgentRuntime({ dbPath: path.join(root, 'state.db'), registry, executor: async tool => tool.handler(tool.input) }) };
}

test('desktop runtime executes governed tools and persists checkpoints', async () => {
    const { root, runtime } = makeRuntime();
    try {
        const run = runtime.createRun({ goal: '读取工作区文件' });
        const result = await runtime.execute(run.id, [{ tool: 'filesystem.read', input: { path: 'report.csv' } }]);
        assert.equal(result.status, 'completed');
        assert.equal(result.run.status, 'completed');
        assert.equal(runtime.store.listSteps(run.id).some(step => step.phase === 'execute'), true);
        assert.equal(runtime.store.recoverRun(run.id).checkpoint.state.output.ok, true);
        const planStep = runtime.store.listSteps(run.id).find(step => step.phase === 'plan');
        assert.match(planStep.output.contextHash, /^[a-f0-9]{64}$/);
        assert.match(planStep.output.worldStateHash, /^[a-f0-9]{64}$/);
    } finally {
        runtime.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('desktop runtime pauses risky tools for approval and resumes after approval', async () => {
    const { root, runtime } = makeRuntime();
    try {
        const run = runtime.createRun({ goal: '写入记录' });
        const paused = await runtime.execute(run.id, [{ tool: 'database.insert', input: { value: 'x' } }]);
        assert.equal(paused.status, 'waiting_approval');
        assert.equal(runtime.store.getRun(run.id).status, 'waiting_approval');
        const resumed = await runtime.execute(run.id, [{ tool: 'database.insert', input: { value: 'x' } }], { approvalGranted: true });
        assert.equal(resumed.status, 'completed');
        assert.equal(runtime.store.getRun(run.id).status, 'completed');
    } finally {
        runtime.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('desktop runtime recovery requires approval for pending non-idempotent calls', () => {
    const { root, runtime } = makeRuntime();
    try {
        const run = runtime.createRun({ goal: '恢复任务' });
        runtime.store.transitionRun(run.id, 'planning');
        runtime.store.transitionRun(run.id, 'executing');
        runtime.store.beginTool({ runId: run.id, stepId: 'step', operationKey: 'op-1', toolName: 'database.insert', input: { value: 'x' }, inputHash: 'h', idempotent: false, policyDecision: 'allow' });
        const recovered = runtime.recover(run.id);
        assert.equal(recovered.requiresApproval, true);
        assert.equal(recovered.run.status, 'waiting_approval');
    } finally {
        runtime.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('desktop runtime persists budget usage and trips the execution watchdog', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-desktop-agent-watchdog-'));
    const registry = new ToolRegistry([{ name: 'slow.read', timeout: { max_seconds: 1 }, input_schema: { type: 'object' } }]);
    const runtime = new DesktopAgentRuntime({
        dbPath: path.join(root, 'state.db'),
        registry,
        executor: () => new Promise(() => {})
    });
    try {
        const run = runtime.createRun({ goal: '看门狗测试', budgetConfig: { max_runtime_seconds: 1 } });
        await assert.rejects(() => runtime.execute(run.id, [{ tool: 'slow.read', input: {} }], { timeoutMs: 100 }), error => error.code === 'AGENT_RUNTIME_TIMEOUT');
        const persisted = runtime.store.getRun(run.id);
        assert.equal(persisted.usageStats.counts.tool_calls, 1);
        assert.equal(persisted.status, 'diagnosing');
    } finally {
        runtime.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('desktop runtime rejects operation-key input substitution', () => {
    const { root, runtime } = makeRuntime();
    try {
        const run = runtime.createRun({ goal: '操作键校验' });
        runtime.store.beginTool({ runId: run.id, stepId: 'step', operationKey: 'same-key', toolName: 'filesystem.read', input: { path: 'a' }, inputHash: 'hash-a', idempotent: true, policyDecision: 'allow' });
        assert.throws(() => runtime.store.beginTool({ runId: run.id, stepId: 'step', operationKey: 'same-key', toolName: 'filesystem.read', input: { path: 'b' }, inputHash: 'hash-b', idempotent: true, policyDecision: 'allow' }), /输入摘要不匹配/);
    } finally { runtime.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('desktop runtime never replays a pending non-idempotent call without renewed approval', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-desktop-agent-replay-'));
    let sideEffects = 0;
    const registry = new ToolRegistry([{
        name: 'database.insert',
        risk_level: 5,
        side_effect: true,
        approval_required: true,
        input_schema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } },
        handler: async () => ({ inserted: true })
    }]);
    const runtime = new DesktopAgentRuntime({
        dbPath: path.join(root, 'state.db'),
        registry,
        executor: async () => { sideEffects += 1; return { inserted: true }; }
    });
    try {
        const run = runtime.createRun({ goal: '非幂等恢复矩阵' });
        runtime.store.transitionRun(run.id, 'planning');
        runtime.store.transitionRun(run.id, 'executing');
        const input = { value: 'x' };
        const inputHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
        runtime.store.beginTool({ runId: run.id, stepId: 'step', operationKey: 'same-op', toolName: 'database.insert', input, inputHash, idempotent: false, policyDecision: 'allow' });
        assert.equal(runtime.recover(run.id).requiresApproval, true);
        const blocked = await runtime.execute(run.id, [{ tool: 'database.insert', operationKey: 'same-op', input: { value: 'x' } }]);
        assert.equal(blocked.status, 'waiting_approval');
        assert.equal(sideEffects, 0);
        const resumed = await runtime.execute(run.id, [{ tool: 'database.insert', operationKey: 'same-op', input: { value: 'x' } }], { approvalGranted: true });
        assert.equal(resumed.status, 'completed');
        assert.equal(sideEffects, 1);
    } finally {
        runtime.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
