const assert = require('node:assert/strict');
const test = require('node:test');

const { executeDagNodeWithPolicy } = require('../server/services/agent-dag-runtime');
const { stableDagOperationKey } = require('../server/services/agent-dag-approval');

test('DAG 节点重试复用稳定 checkpoint operation key，不把 attempt 拼入账本键', async () => {
    const operationKeys = [];
    let attempts = 0;
    const run = { id: 'dag-operation-key-run' };
    const node = { id: 'export-node', tool: 'fixture.export', title: '导出' };
    const input = { reportId: 'r-1' };
    const result = await executeDagNodeWithPolicy({
        run,
        user: { id: 1 },
        modelCfg: {},
        node,
        resolvedInput: input,
        toolList: [],
        deadline: Date.now() + 30_000,
        policy: { retryLimit: 1, timeoutMs: 10_000 },
        stepIndex: 7,
        executionContext: { stepContext: { contextHash: 'dag-context' } }
    }, {
        async assertRunNotCancelled() {},
        async withTimeout(execute) { return execute(); },
        async executeToolByName(_name, _input, _user, _toolList, context) {
            operationKeys.push(context.operationKey);
            attempts += 1;
            if (attempts === 1) throw Object.assign(new Error('临时失败'), { code: 'ETEMPORARY' });
            return { delivered: true };
        },
        async recordAgentToolCall() {},
        async insertStep() {},
        async listSteps() { return []; },
        async waitForDagRetry() {}
    });

    assert.equal(result.ok, true);
    assert.equal(result.attempt, 2);
    assert.deepEqual(operationKeys, [
        stableDagOperationKey(run, node, input),
        stableDagOperationKey(run, node, input)
    ]);
});
