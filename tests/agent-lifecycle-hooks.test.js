'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    evaluateDeclarativeHook,
    hookPayloadFingerprint,
    invokeAgentLifecycleHooks,
    manifestDigestForHook,
    normalizeHookRegistration
} = require('../server/services/agent-lifecycle-hooks');
const { isWorkspaceMutation } = require('../server/services/agent-tool-orchestrator');

test('lifecycle hooks accept only typed events and declarative policy handlers', () => {
    const hook = normalizeHookRegistration({
        hookName: 'block-external-write', eventType: 'tool.preflight', phase: 'pre', status: 'enabled', signatureVerified: true,
        config: { blockedTools: ['agent.http'], action: 'deny', additionalContext: '外部写入已被组织策略阻断。' }
    }, { tenantId: 5, userId: 7 });
    assert.equal(hook.handlerKind, 'declarative_policy');
    assert.equal(hook.failurePolicy, 'fail_closed', '工具前置 Hook 必须强制 fail-closed');
    assert.deepEqual(hook.config.blockedTools, ['agent.http']);
    assert.throws(
        () => normalizeHookRegistration({ hookName: 'bad', eventType: 'shell.before', phase: 'pre' }),
        error => error.code === 'AGENT_HOOK_EVENT_INVALID'
    );
});

test('declarative preflight hook can only tighten a policy decision', () => {
    const denied = evaluateDeclarativeHook({
        config: { blockedTools: ['agent.http'], action: 'deny' }
    }, { tool: { name: 'agent.http', risk_level: 4 }, run: { run_mode: 'standard' } });
    assert.deepEqual(denied, { decision: 'deny', reason: 'tool_blocked', additionalContext: '' });
    const observed = evaluateDeclarativeHook({
        config: { maxRiskLevel: 2, action: 'observe', additionalContext: '记录即可。' }
    }, { tool: { name: 'agent.http', risk_level: 4 }, run: { run_mode: 'standard' } });
    assert.deepEqual(observed, { decision: 'observe', additionalContext: '记录即可。' });
});

test('lifecycle hook enforces signed manifest, scope, schema, timeout and audit ordering', async () => {
    const hook = normalizeHookRegistration({
        id: '5c7b580d-8368-4f79-8d33-beb6db48ae80', packageId: 'policy.scope', packageVersion: '1', hookName: 'contract-hook',
        eventType: 'tool.preflight', phase: 'pre', status: 'enabled', signatureVerified: true, timeoutMs: 50,
        requiredScopes: ['agent.tools.execute'],
        inputSchema: { type: 'object', required: ['tool'], properties: { tool: { type: 'object' } } },
        outputSchema: { type: 'object', required: ['decision'], properties: { decision: { type: 'string' } } },
        config: { blockedTools: ['agent.http'], action: 'deny' }
    }, { tenantId: 5, userId: 7 });
    assert.equal(hook.manifestDigest, manifestDigestForHook(hook));
    const audit = [];
    const invoke = payload => invokeAgentLifecycleHooks({ eventType: 'tool.preflight', phase: 'pre', user: { id: 7, tenant_id: 5 }, payload }, {
        listHooks: async () => [hook],
        recordAudit: async entry => audit.push(entry)
    });
    await assert.rejects(
        () => invoke({ tool: { name: 'agent.http' }, run: { run_mode: 'standard' } }),
        error => error.code === 'AGENT_HOOK_FAILED_CLOSED'
    );
    const result = await invoke({ tool: { name: 'agent.http' }, run: { run_mode: 'standard' }, authorizedScopes: ['agent.tools.execute'] });
    assert.equal(result.decisions[0].decision, 'deny');
    assert.equal(audit.at(-1).sequenceNo, 1);
    assert.equal(audit.at(-1).outcome, 'succeeded');

    await assert.rejects(
        () => invoke({ tool: 'not-an-object', authorizedScopes: ['agent.tools.execute'] }),
        error => error.code === 'AGENT_HOOK_FAILED_CLOSED'
    );
    await assert.rejects(
        () => invokeAgentLifecycleHooks({ eventType: 'tool.preflight', phase: 'pre', user: { id: 7, tenant_id: 5 }, payload: { tool: {}, authorizedScopes: ['agent.tools.execute'] } }, {
            listHooks: async () => [hook],
            evaluateHook: async () => await new Promise(resolve => setTimeout(() => resolve({ decision: 'observe' }), 80)),
            recordAudit: async entry => audit.push(entry)
        }),
        error => error.code === 'AGENT_HOOK_FAILED_CLOSED'
    );
    assert.equal(audit.at(-1).outcome, 'failed');
});

test('hook audit fingerprint is keyed and never exposes the raw lifecycle payload', () => {
    const payload = { run: { id: 'run-secret' }, input: { token: 'do-not-store' } };
    const fingerprint = hookPayloadFingerprint(payload, { PIVOT_HOOK_AUDIT_FINGERPRINT_SECRET: 'hook-audit-test-secret-01234567890123456789' });
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.notEqual(fingerprint, hookPayloadFingerprint(payload, { PIVOT_HOOK_AUDIT_FINGERPRINT_SECRET: 'another-hook-audit-secret-012345678901234' }));
    assert.equal(hookPayloadFingerprint(payload, {}), '');
});

test('workspace lifecycle events are emitted only for mutating workspace paths', () => {
    assert.equal(isWorkspaceMutation({ name: 'workspace.patch' }), true);
    assert.equal(isWorkspaceMutation({ name: 'workspace.git_diff' }), false);
    assert.equal(isWorkspaceMutation({ name: 'terminal.runtime' }, { action: 'write' }), true);
    assert.equal(isWorkspaceMutation({ name: 'terminal.runtime' }, { action: 'list' }), false);
});
