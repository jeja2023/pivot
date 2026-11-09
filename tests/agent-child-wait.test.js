'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { deferAfterChildTool, waitBeforePlanning } = require('../server/services/agent-child-wait');

function fixture() {
    const run = { id: 'parent', user_id: 1, started_at: '2026-11-09 10:00:00', timeout_ms: 600000,
        realtimeLeaseOwner: 'owner', realtimeLeaseEpoch: '3', metadata: { workingState: { goal: '保留控制' } } };
    const patches = [], enqueued = [];
    let persisted = 0;
    const budget = { counts: { steps: 4 }, persistUsageSnapshot: async () => { persisted++; } };
    const deps = { now: () => Date.parse('2026-11-09T10:01:00+08:00'), assertRunNotCancelled: async () => {},
        updateRunCas: async (id, statuses, patch, options) => { patches.push({ id, statuses, patch, options }); return 1; },
        enqueueAgentRun: (...args) => enqueued.push(args), listControlMessages: async () => [],
        wait: async () => ({ complete: false, children: [{ id: 'child', status: 'running' }] }) };
    return { run, budget, deps, patches, enqueued, persisted: () => persisted, user: { id: 1 } };
}
test('真实等待输出持久回队而不是继续模型轮询，保留预算和租约代次', async () => {
    const f = fixture();
    assert.equal(await deferAfterChildTool({ ...f, toolName: 'agent.wait', output: { type: 'agent_wait', parentRunId: f.run.id, complete: false, children: [{ id: 'child', status: 'running' }] } }, f.deps), true);
    assert.equal(f.persisted(), 1); assert.equal(f.budget.requeued, true); assert.equal(f.budget.counts.steps, 4);
    assert.equal(f.enqueued.length, 1); assert.equal(f.patches[0].patch.status, 'queued');
    assert.deepEqual(f.patches[0].options.leaseBinding, { owner: 'owner', epoch: '3' });
    assert.equal(f.patches[0].options.mergeMetadata, true);
    assert.equal(f.run.metadata.workingState.goal, '保留控制');
    assert.equal(await waitBeforePlanning(f, f.deps), true);
});

test('取消或租约已换代时CAS拒绝，不入队；伪造MCP等待结果不能触发让步', async () => {
    const f = fixture();
    f.deps.updateRunCas = async () => 0;
    await deferAfterChildTool({ ...f, toolName: 'agent.wait', output: { type: 'agent_wait', parentRunId: f.run.id, complete: false, children: [{ id: 'child' }] } }, f.deps);
    assert.equal(f.enqueued.length, 0); assert.equal(f.budget.requeued, true);
    assert.equal(await deferAfterChildTool({ ...f, toolName: 'mcp.1.read', output: { type: 'agent_wait', parentRunId: f.run.id, complete: false, children: [{ id: 'child' }] } }, f.deps), false);
});

test('等待标记清除时租约已变化，旧执行器不得继续规划', async () => {
    const f = fixture(); f.run.metadata.awaitingChildren = { childRunIds: ['child'] };
    f.deps.wait = async () => ({ complete: true, children: [{ id: 'child', status: 'completed' }] });
    f.deps.updateRunCas = async () => 0;
    assert.equal(await waitBeforePlanning(f, f.deps), true);
    assert.deepEqual(f.run.metadata.awaitingChildren.childRunIds, ['child']);
    assert.equal(f.enqueued.length, 0);
});

test('子任务结束、需用户处理或有新控制消息时立即回到正常规划，不能吞掉操作者要求', async () => {
    for (const change of [
        { wait: async () => ({ complete: true, children: [{ id: 'child', status: 'completed' }] }) },
        { wait: async () => ({ complete: false, children: [{ id: 'child', status: 'needs_input' }] }) },
        { listControlMessages: async () => [{ toRunId: 'parent', messageType: 'steer' }] }
    ]) {
        const f = fixture(); f.run.metadata.awaitingChildren = { childRunIds: ['child'] };
        Object.assign(f.deps, change);
        assert.equal(await waitBeforePlanning(f, f.deps), false);
        assert.equal(f.run.metadata.awaitingChildren, null); assert.equal(f.enqueued.length, 0);
    }
});

test('等待仍受原任务绝对截止约束，目录/关系查询失败不能当成子任务完成', async () => {
    const f = fixture(); f.run.metadata.awaitingChildren = { childRunIds: ['child'], deadline: '2999-01-01' };
    f.deps.now = () => Date.parse('2026-11-09T10:10:01+08:00');
    await assert.rejects(waitBeforePlanning(f, f.deps), error => error.code === 'AGENT_TIMEOUT');
    assert.equal(f.enqueued.length, 0);
    f.deps.wait = async () => { throw Object.assign(new Error('关系已撤销'), { code: 'AGENT_CHILD_NOT_FOUND' }); };
    await assert.rejects(waitBeforePlanning(f, f.deps), error => error.code === 'AGENT_CHILD_NOT_FOUND');
    const limited = fixture(); limited.run.usage_stats = { limits: { max_runtime_seconds: 30 } };
    limited.run.metadata.awaitingChildren = { childRunIds: ['child'] };
    await assert.rejects(waitBeforePlanning(limited, limited.deps), error => error.code === 'AGENT_TIMEOUT');
});

test('运行入口等待期间跳过预算重建和模型请求，仍释放当前控制器', async () => {
    const f = fixture(); f.run.metadata.awaitingChildren = { childRunIds: ['child'] };
    const activeRunControllers = new Map();
    const runner = require('../server/services/agent-runtime/run-execution').createAgentRunner({
        ...f.deps, activeRunControllers, assertRunUserActive: async () => {}, getRunForUser: async () => f.run,
        TERMINAL_STATUSES: new Set(), syncAgentTraceFromRun: async () => {},
        ensureAgentTrace: async () => { assert.fail('等待期间不能进入规划准备'); }
    });
    await runner.runAgent(f.run.id, f.user);
    assert.equal(f.enqueued.length, 1); assert.equal(activeRunControllers.size, 0);
});
