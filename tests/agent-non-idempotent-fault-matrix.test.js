const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ToolRegistry } = require('../server/services/agent-contracts');
const { DesktopAgentRuntime } = require('../desktop/agent-runtime');

function makeMatrixRuntime(executor) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-agent-fault-matrix-'));
    const registry = new ToolRegistry([{
        name: 'external.charge',
        risk_level: 5,
        side_effect: true,
        approval_required: true,
        input_schema: { type: 'object', required: ['requestId'], properties: { requestId: { type: 'string' } } }
    }]);
    return {
        root,
        runtime: new DesktopAgentRuntime({ dbPath: path.join(root, 'state.db'), registry, executor })
    };
}

function cleanup({ root, runtime }) {
    runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
}

test('non-idempotent fault matrix never auto-replays ambiguous side effects', async () => {
    const scenarios = [
        { name: 'timeout', executor: () => new Promise(() => {}), expected: 'AGENT_RUNTIME_TIMEOUT' },
        { name: 'process-crash-before-commit', executor: async () => { throw Object.assign(new Error('worker exited'), { code: 'WORKER_EXITED' }); }, expected: 'WORKER_EXITED' },
        { name: 'external-service-error', executor: async () => { throw Object.assign(new Error('upstream unavailable'), { code: 'UPSTREAM_UNAVAILABLE' }); }, expected: 'UPSTREAM_UNAVAILABLE' }
    ];
    for (const scenario of scenarios) {
        const fixture = makeMatrixRuntime(scenario.executor);
        try {
            const run = fixture.runtime.createRun({ goal: scenario.name });
            await assert.rejects(
                fixture.runtime.execute(run.id, [{ tool: 'external.charge', input: { requestId: scenario.name } }], { approvalGranted: true, timeoutMs: 100 }),
                error => error.code === scenario.expected
            );
            const call = fixture.runtime.store.listToolCalls(run.id)[0];
            assert.equal(call.status, 'error');
            assert.equal(call.side_effect, true);
            assert.equal(fixture.runtime.recover(run.id).requiresApproval, false, 'committed error has no pending auto-replay');
        } finally {
            cleanup(fixture);
        }
    }

    const fixture = makeMatrixRuntime(async () => ({ charged: true }));
    let executions = 0;
    fixture.runtime.executor = async () => { executions += 1; return { charged: true }; };
    try {
        const run = fixture.runtime.createRun({ goal: 'duplicate-delivery' });
        fixture.runtime.store.transitionRun(run.id, 'planning');
        fixture.runtime.store.transitionRun(run.id, 'executing');
        const input = { requestId: 'duplicate-delivery' };
        const inputHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
        fixture.runtime.store.beginTool({ runId: run.id, stepId: 'step', operationKey: 'duplicate-key', toolName: 'external.charge', input, inputHash, idempotent: false, policyDecision: 'allow' });
        fixture.runtime.store.completeTool('duplicate-key', { charged: true });
        const replay = await fixture.runtime.execute(run.id, [{ tool: 'external.charge', operationKey: 'duplicate-key', input }], { approvalGranted: true });
        assert.equal(replay.status, 'completed');
        assert.equal(executions, 0, 'completed operation key is replayed from the ledger');
    } finally {
        cleanup(fixture);
    }
});

test('ambiguous external commit requires renewed approval before any retry', async () => {
    const fixture = makeMatrixRuntime(async () => ({ charged: true }));
    let executions = 0;
    fixture.runtime.executor = async () => { executions += 1; return { charged: true }; };
    try {
        const run = fixture.runtime.createRun({ goal: 'ambiguous external commit' });
        fixture.runtime.store.transitionRun(run.id, 'planning');
        fixture.runtime.store.transitionRun(run.id, 'executing');
        const input = { requestId: 'ambiguous-commit' };
        const inputHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
        fixture.runtime.store.beginTool({ runId: run.id, stepId: 'step', operationKey: 'ambiguous-key', toolName: 'external.charge', input, inputHash, idempotent: false, policyDecision: 'allow' });
        const recovered = fixture.runtime.recover(run.id);
        assert.equal(recovered.requiresApproval, true);
        const blocked = await fixture.runtime.execute(run.id, [{ tool: 'external.charge', operationKey: 'ambiguous-key', input }]);
        assert.equal(blocked.status, 'waiting_approval');
        assert.equal(executions, 0);
        const resumed = await fixture.runtime.execute(run.id, [{ tool: 'external.charge', operationKey: 'ambiguous-key', input }], { approvalGranted: true });
        assert.equal(resumed.status, 'completed');
        assert.equal(executions, 1);
    } finally {
        cleanup(fixture);
    }
});
