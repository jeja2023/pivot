'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAgentCodeRuntime, normalizeCodeInput } = require('../server/services/agent-code-runtime');

const PINNED_IMAGE = 'registry.example/pivot/code-runner@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('code runtime only uses a configured capability worker with a consumed grant', async () => {
    const consumed = [];
    const workerCalls = [];
    const runtime = createAgentCodeRuntime({
        isWorkerEnabled: () => true,
        normalizeWorkerDefinition: definition => definition,
        verifyExecutionGrant: (token, expected) => {
            assert.equal(token, 'short-lived-grant');
            assert.equal(expected.runId, 'code-run');
            assert.equal(expected.tool, 'agent.code');
            assert.deepEqual(expected.input, { code: 'return vars.value * 2;', vars: { value: 21 } });
            return { payload: { grantId: 'code-grant', runId: 'code-run' }, summary: { grantId: 'code-grant', tool: 'agent.code' } };
        },
        consumeExecutionGrant: async value => { consumed.push(value); return { consumed: true }; },
        runCapabilityWorker: async (...args) => {
            workerCalls.push(args);
            return { ok: true, result: { value: 42 } };
        }
    });
    const result = await runtime.executeAgentCode({ code: 'return vars.value * 2;', vars: { value: 21 } }, { id: 7 }, {
        run: { id: 'code-run' },
        executionGrant: 'short-lived-grant',
        env: { PIVOT_AGENT_CODE_WORKER_IMAGE: PINNED_IMAGE, PIVOT_CAPABILITY_WORKER_ENABLED: 'true' }
    });
    assert.deepEqual(result.result, { value: 42 });
    assert.equal(result.worker.isolation.enforcement, 'enforced');
    assert.equal(consumed.length, 1);
    assert.equal(workerCalls.length, 1);
    assert.equal(workerCalls[0][1].action, 'code');
    assert.equal(workerCalls[0][2].requireExecutionGrant, true);
    assert.equal(workerCalls[0][2].executionGrant, 'short-lived-grant');
});

test('code runtime fails closed before validating arbitrary source without a pinned worker', async () => {
    const runtime = createAgentCodeRuntime();
    await assert.rejects(
        () => runtime.executeAgentCode({ code: 'return 1;' }, { id: 7 }, { run: { id: 'code-run' }, executionGrant: 'unused', env: {} }),
        error => error.code === 'AGENT_CODE_WORKER_REQUIRED'
    );
});

test('code runtime enforces bounded, serializable inputs before worker dispatch', () => {
    assert.throws(
        () => normalizeCodeInput({ code: '' }),
        error => error.code === 'AGENT_CODE_REQUIRED'
    );
    assert.throws(
        () => normalizeCodeInput({ code: 'x', vars: { value: BigInt(1) } }),
        error => error.code === 'AGENT_CODE_VARS_INVALID'
    );
});
