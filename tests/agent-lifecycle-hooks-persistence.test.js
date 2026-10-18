'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { queryOne } = require('../server/db/client');
const {
    invokeAgentLifecycleHooks,
    listAgentLifecycleHooks,
    listAgentLifecycleHookInvocations,
    registerAgentLifecycleHook
} = require('../server/services/agent-lifecycle-hooks');

test('only a trusted signature-verification path can enable a declarative preflight hook', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const request = {
        packageId: `test.hook.${suffix}`,
        packageVersion: '1', hookName: 'block-external-http',
        eventType: 'tool.preflight', phase: 'pre', status: 'enabled', signatureVerified: true,
        config: { blockedTools: ['agent.http'], action: 'deny', additionalContext: '测试策略阻断 HTTP。' }
    };
    await assert.rejects(
        () => registerAgentLifecycleHook({ id: user.id }, request),
        error => error.code === 'AGENT_HOOK_SIGNATURE_REQUIRED'
    );
    const hook = await registerAgentLifecycleHook({ id: user.id }, request, { verifiedSignature: true });
    assert.equal(hook.status, 'enabled');
    assert.equal(hook.failurePolicy, 'fail_closed');
    const decisions = await invokeAgentLifecycleHooks({
        eventType: 'tool.preflight', phase: 'pre', user: { id: user.id },
        payload: { tool: { name: 'agent.http', risk_level: 4 }, run: { run_mode: 'standard' } }
    });
    assert.equal(decisions.decisions.some(item => item.hookId === hook.id && item.decision === 'deny'), true);
    const nonMatching = await invokeAgentLifecycleHooks({
        eventType: 'tool.preflight', phase: 'pre', user: { id: user.id },
        payload: { tool: { name: 'rag.search', risk_level: 1 }, run: { run_mode: 'standard' } }
    });
    assert.equal(nonMatching.decisions.find(item => item.hookId === hook.id)?.decision, 'observe');
    const listed = await listAgentLifecycleHooks({ id: user.id });
    assert.equal(listed.some(item => item.id === hook.id), true);
    const audits = await listAgentLifecycleHookInvocations({ id: user.id }, { hookId: hook.id });
    assert.equal(audits.some(item => item.decision === 'deny' && item.outcome === 'succeeded'), true);
    assert.equal(audits.every(item => !Object.hasOwn(item, 'payload')), true);
    await assert.rejects(
        () => registerAgentLifecycleHook({ id: user.id }, {
            ...request,
            config: { blockedTools: ['rag.search'], action: 'deny' }
        }, { verifiedSignature: true }),
        error => error.code === 'AGENT_HOOK_RELEASE_IMMUTABLE'
    );
    await assert.rejects(
        () => registerAgentLifecycleHook({ id: user.id }, {
            ...request,
            packageVersion: '2', userId: Number(user.id) + 1
        }, { verifiedSignature: true }),
        error => error.code === 'AGENT_HOOK_USER_FORBIDDEN'
    );
});
