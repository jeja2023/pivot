const assert = require('node:assert/strict');
const test = require('node:test');
const { runAgentDag } = require('../server/services/agent-dag-runtime');
const { withTimeout } = require('../server/services/agent-runtime/runtime-env');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(nodes, execute, overrides = {}) {
    const persisted = new Map(); const events = []; const updates = []; let active = 0; let peak = 0;
    const run = { id: `scheduler-${Math.random()}`, goal: '调度回归', metadata: { dagSpec: { nodes, cacheEnabled: false } }, retry_limit: 0 };
    const deps = {
        getRunMetadata: value => value.metadata, listDagNodes: async () => [], listSteps: async () => [],
        upsertDagNode: async (_id, node, patch) => { persisted.set(node.id, { ...persisted.get(node.id), ...patch }); },
        assertRunNotCancelled: async () => {}, insertStep: async () => {}, updateRun: async (_id, patch) => updates.push(patch),
        createAgentNotification: async () => {}, getAgentRunTitle: () => '调度回归', dagNodeConcurrency: 2, agentToolTimeoutMs: 30000,
        maybePauseForApproval: async () => false, isApprovalGranted: () => true,
        withTimeout, recordAgentToolCall: async () => {}, verifyAgentOutcome: async () => ({ outcomeStatus: 'verified', hardFailures: [] }),
        executeToolByName: async (_name, input, _user, _tools, context) => {
            active++; peak = Math.max(peak, active); events.push(`${input.template}:start`);
            try { return await execute(input.template, context); } finally { events.push(`${input.template}:end`); active--; }
        }, ...overrides
    };
    const start = () => runAgentDag({ run, user: { id: 1 }, modelCfg: null, toolList: [{ name: 'workflow.template' }, { name: 'workflow.approval' }, { name: 'workflow.delay' }], deadline: Date.now() + 10000, assertRunWithinBudget: overrides.assertRunWithinBudget || (() => {}) }, deps);
    return { start, persisted, events, updates, peak: () => peak, active: () => active };
}
const node = (id, dependsOn = [], extra = {}) => ({ id, tool: 'workflow.template', input: { template: id }, dependsOn, retryLimit: 0, ...extra });

test('快节点完成即启动下游，不等待同批慢支线，并且不超过并发上限', async () => {
    const slow = deferred(); const childStarted = deferred();
    const current = fixture([node('slow'), node('fast'), node('child', ['fast'])], async id => {
        if (id === 'slow') await slow.promise;
        if (id === 'child') childStarted.resolve();
        return { text: id };
    });
    const running = current.start();
    await Promise.race([childStarted.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('空闲槽位没有及时启动下游。')), 2000))]);
    assert.ok(current.events.includes('child:start'));
    assert.ok(!current.events.includes('slow:end'));
    assert.equal(current.peak(), 2);
    slow.resolve(); await running;
    assert.equal(current.updates.at(-1).status, 'completed');
});

test('停止策略取消同级在途节点且不启动其下游', async () => {
    const slowStarted = deferred();
    const current = fixture([node('slow'), node('fail', [], { onError: 'stop' }), node('child', ['slow'])], async (id, context) => {
        if (id === 'slow') {
            slowStarted.resolve();
            await new Promise((resolve, reject) => { context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }); });
        }
        if (id === 'fail') { await slowStarted.promise; throw new Error('明确失败'); }
        return { text: id };
    });
    await assert.rejects(current.start(), /明确失败|停止/);
    assert.equal(current.active(), 0);
    assert.ok(!current.events.includes('child:start'));
});

test('失败继续策略保留失败标识且按依赖语义运行下游', async () => {
    const current = fixture([node('fail', [], { onError: 'continue' }), node('child', ['fail'])], async id => {
        if (id === 'fail') throw new Error('可继续失败');
        return { text: id };
    });
    await current.start();
    assert.equal(current.persisted.get('fail').status, 'continued_error');
    assert.equal(current.persisted.get('child').status, 'completed');
});

test('取消信号结束在途节点，绝不执行尚未开始的后续步骤', async () => {
    const controller = new AbortController(); const started = deferred();
    const current = fixture([node('slow'), node('child', ['slow'])], async (_id, context) => {
        started.resolve();
        await new Promise((resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
    }, { signal: controller.signal });
    const running = current.start(); await started.promise; controller.abort(new Error('用户取消'));
    await assert.rejects(running, /用户取消/);
    assert.equal(current.active(), 0); assert.ok(!current.events.includes('child:start'));
});

test('审批与延时挂起会清理同级在途任务，绝不提前启动后续步骤', async () => {
    for (const waitingTool of ['workflow.approval', 'workflow.delay']) {
    const slowStarted = deferred();
    const current = fixture([node('slow'), node('approval', [], { tool: waitingTool }), node('child', ['approval'])], async (_id, context) => {
        slowStarted.resolve();
        await new Promise((resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
    }, { [waitingTool === 'workflow.approval' ? 'waitForWorkflowApproval' : 'waitForWorkflowDelay']: async () => { await slowStarted.promise; throw Object.assign(new Error('等待业务审批或延时'), { code: 'AGENT_APPROVAL_REQUIRED' }); } });
    await assert.rejects(current.start(), error => error.code === 'AGENT_APPROVAL_REQUIRED');
    assert.equal(current.active(), 0); assert.ok(!current.events.includes('child:start'));
    }
});

test('节点预算不足时不启动新工具，租约失效会清理仍在执行的分支', async () => {
    for (const category of ['budget', 'lease']) {
        let steps = 0;
        const current = fixture([node('slow'), node('fast'), node('child', ['fast'])], async (id, context) => {
            if (id === 'slow') await new Promise((resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
            return { text: id };
        }, category === 'budget' ? { taskBudget: { consumeStep: () => { if (++steps > 2) throw new Error('步骤预算不足'); } } } : { assertRunNotCancelled: async () => { if (current.events.includes('fast:end')) throw new Error('运行租约已失效'); } });
        await assert.rejects(current.start(), category === 'budget' ? /步骤预算不足/ : /运行租约已失效/);
        assert.equal(current.active(), 0); assert.ok(!current.events.includes('child:start'));
    }
});
