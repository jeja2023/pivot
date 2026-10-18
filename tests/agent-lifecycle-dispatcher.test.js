'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    dispatchPreLifecycleHook,
    dispatchPostLifecycleHook,
    lifecycleHooksEnabled
} = require('../server/services/agent-lifecycle-dispatcher');

test('pre lifecycle dispatcher preserves a deny decision before a state transition', async () => {
    const events = [];
    const result = await dispatchPreLifecycleHook({
        eventType: 'run.started', user: { id: 7 }, run: { id: 'run-pre', user_id: 7 },
        context: { lifecycleHooksEnabled: true }, eventKey: 'start:run-pre',
        payload: { run: { id: 'run-pre', run_mode: 'standard' } },
        invokeHooks: async request => {
            assert.equal(request.phase, 'pre');
            assert.equal(request.eventType, 'run.started');
            return { decisions: [{ hookId: 'h-deny', hookName: 'no-start', decision: 'deny', reason: 'organization_hold' }], additionalContext: [] };
        },
        recordEvent: async event => events.push(event)
    });
    assert.equal(result.dispatched, true);
    assert.equal(result.denied, true);
    assert.equal(result.blocking.hookId, 'h-deny');
    assert.deepEqual(events, [{
        runId: 'run-pre', userId: 7, type: 'hook.preflight', eventKey: 'start:run-pre',
        payload: {
            hookEventType: 'run.started',
            hookDecisions: [{ hookId: 'h-deny', decision: 'deny', reason: 'organization_hold' }],
            hookContextCount: 0,
            denied: true
        }
    }]);
});

test('post lifecycle dispatcher is feature-gated and records only a safe decision summary', async () => {
    assert.equal(lifecycleHooksEnabled({ env: { PIVOT_AGENT_LIFECYCLE_HOOKS_ENABLED: 'false' } }), false);
    const skipped = await dispatchPostLifecycleHook({
        eventType: 'transaction.committed', user: { id: 7 }, run: { id: 'run-1' },
        context: { env: { PIVOT_AGENT_LIFECYCLE_HOOKS_ENABLED: 'false' } },
        invokeHooks: async () => { throw new Error('不应调用'); }
    });
    assert.deepEqual(skipped, { dispatched: false, reason: 'disabled' });

    const events = [];
    const delivered = await dispatchPostLifecycleHook({
        eventType: 'transaction.committed', user: { id: 7 }, run: { id: 'run-1', user_id: 7 },
        context: { lifecycleHooksEnabled: true, authorizedScopes: ['agent.transactions.read'] }, eventKey: 'commit:tx-1',
        payload: { transaction: { id: 'tx-1', status: 'committed' } },
        invokeHooks: async request => {
            assert.equal(request.phase, 'post');
            assert.equal(request.eventType, 'transaction.committed');
            assert.deepEqual(request.payload.authorization.scopes, ['agent.transactions.read']);
            return { decisions: [{ hookId: 'h-1', decision: 'observe', reason: 'recorded' }], additionalContext: [{ hookId: 'h-1', text: 'private' }] };
        },
        recordEvent: async event => events.push(event)
    });
    assert.equal(delivered.dispatched, true);
    assert.deepEqual(events, [{
        runId: 'run-1', userId: 7, type: 'hook.post', eventKey: 'commit:tx-1',
        payload: { hookEventType: 'transaction.committed', hookDecisions: [{ hookId: 'h-1', decision: 'observe', reason: 'recorded' }], hookContextCount: 1 }
    }]);
});

test('post lifecycle dispatcher reports hook failure to audit but does not change an already-final state', async () => {
    const events = [];
    const result = await dispatchPostLifecycleHook({
        eventType: 'transaction.rolled_back', user: { id: 7 }, run: { id: 'run-2', user_id: 7 },
        context: { lifecycleHooksEnabled: true }, eventKey: 'rollback:tx-2',
        invokeHooks: async () => { const error = new Error('Hook 后端不可用'); error.code = 'HOOK_DOWN'; throw error; },
        recordEvent: async event => events.push(event)
    });
    assert.equal(result.dispatched, false);
    assert.equal(result.error.code, 'HOOK_DOWN');
    assert.equal(events[0].type, 'hook.post_failed');
    assert.equal(events[0].payload.errorCode, 'HOOK_DOWN');
});
