'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { canonicalJson } = require('../server/services/canonical-json');
const { invokeAgentLifecycleHooks } = require('../server/services/agent-lifecycle-hooks');
const { revokeSigningEnvelope } = require('../server/services/agent-skill-signing');
const {
    assertManagedHookPackageActive,
    importManagedHookPackage,
    normalizeManagedHookPackageManifest,
    setManagedHookPackageStatus
} = require('../server/services/agent-lifecycle-hook-packages');

function signManifest(manifest, privateKey) {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(canonicalJson(manifest));
    signer.end();
    return signer.sign(privateKey).toString('base64');
}

test('受管 Hook 包必须由系统管理员以有效组织签名导入，且停用会阻断 fail-closed 预置 Hook', async () => {
    const actor = await queryOne("SELECT * FROM users WHERE username = 'admin' ORDER BY id LIMIT 1");
    assert.ok(actor?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const packageId = `qa.hook.package.${suffix}`;
    const sourceManifest = {
        schemaVersion: 1,
        kind: 'pivot.lifecycle-hook-package',
        packageId,
        packageVersion: '1.0.0',
        hooks: [{
            hookName: 'block-external-http', eventType: 'tool.preflight', phase: 'pre',
            config: { blockedTools: ['agent.http'], action: 'deny' }
        }]
    };
    const manifest = normalizeManagedHookPackageManifest(sourceManifest);
    const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const previousPublicKey = process.env.AGENT_SKILL_PUBLIC_KEY;
    const previousRequired = process.env.AGENT_SKILL_REQUIRE_SIGNATURE;
    process.env.AGENT_SKILL_PUBLIC_KEY = keyPair.publicKey.export({ type: 'spki', format: 'pem' });
    process.env.AGENT_SKILL_REQUIRE_SIGNATURE = 'true';
    try {
        await assert.rejects(
            () => importManagedHookPackage({ ...actor, role: 'user' }, { manifest, signature: { keyId: `hook-${suffix}`, signature: signManifest(manifest, keyPair.privateKey) } }),
            error => error.code === 'AGENT_HOOK_PACKAGE_ADMIN_REQUIRED'
        );
        await assert.rejects(
            () => importManagedHookPackage(actor, { manifest, signature: { keyId: `hook-${suffix}`, signature: 'bad-signature' } }),
            error => error.code === 'SKILL_SIGNATURE_INVALID'
        );
        const imported = await importManagedHookPackage(actor, {
            manifest,
            signature: { keyId: `hook-${suffix}`, signature: signManifest(manifest, keyPair.privateKey) }
        });
        assert.equal(imported.reused, false);
        assert.equal(imported.hooks.length, 1);
        assert.equal(imported.hooks[0].userId, null, '受管 Hook 包必须是组织范围，不能被导入管理员个人绑定');
        assert.match(imported.package.manifestDigest, /^[a-f0-9]{64}$/);
        assert.ok(imported.hooks[0].signingEnvelopeId);
        await assert.doesNotReject(() => assertManagedHookPackageActive(imported.hooks[0]));
        await assert.rejects(
            () => assertManagedHookPackageActive({ ...imported.hooks[0], manifestDigest: 'f'.repeat(64) }),
            error => error.code === 'AGENT_HOOK_PACKAGE_MEMBER_MISMATCH'
        );
        const allowed = await invokeAgentLifecycleHooks({
            eventType: 'tool.preflight', phase: 'pre', user: actor,
            payload: { tool: { name: 'agent.http', risk_level: 4 }, run: { run_mode: 'standard' } }
        });
        assert.equal(allowed.decisions.some(item => item.hookId === imported.hooks[0].id && item.decision === 'deny'), true);
        const sameTenantPeer = await invokeAgentLifecycleHooks({
            eventType: 'tool.preflight', phase: 'pre',
            user: { id: Number(actor.id) + 1000000, tenant_id: imported.package.tenantId },
            payload: { tool: { name: 'agent.http', risk_level: 4 }, run: { run_mode: 'standard' } }
        }, { recordAudit: async () => {} });
        assert.equal(sameTenantPeer.decisions.some(item => item.hookId === imported.hooks[0].id && item.decision === 'deny'), true,
            '同一组织的其他用户必须收到受管 Hook 策略');
        const differentTenant = await invokeAgentLifecycleHooks({
            eventType: 'tool.preflight', phase: 'pre',
            user: { id: Number(actor.id) + 1000001, tenant_id: imported.package.tenantId + 1000 },
            payload: { tool: { name: 'agent.http', risk_level: 4 }, run: { run_mode: 'standard' } }
        }, { recordAudit: async () => {} });
        assert.equal(differentTenant.decisions.some(item => item.hookId === imported.hooks[0].id), false,
            '其他组织不得读取该受管 Hook');
        await setManagedHookPackageStatus(actor, packageId, '1.0.0', 'disabled');
        await assert.rejects(
            () => invokeAgentLifecycleHooks({ eventType: 'tool.preflight', phase: 'pre', user: actor, payload: { tool: { name: 'agent.http' }, run: { run_mode: 'standard' } } }),
            error => error.code === 'AGENT_HOOK_FAILED_CLOSED'
        );
        await setManagedHookPackageStatus(actor, packageId, '1.0.0', 'active');
        await revokeSigningEnvelope(imported.hooks[0].signingEnvelopeId);
        await assert.rejects(
            () => assertManagedHookPackageActive(imported.hooks[0]),
            error => error.code === 'AGENT_HOOK_PACKAGE_SIGNATURE_INVALID'
        );
    } finally {
        await execute('DELETE FROM agent_lifecycle_hook_invocations WHERE hook_id IN (SELECT id FROM agent_lifecycle_hooks WHERE package_id = ? AND package_version = ?)', [packageId, '1.0.0']);
        await execute('DELETE FROM agent_lifecycle_hooks WHERE package_id = ? AND package_version = ?', [packageId, '1.0.0']);
        await execute('DELETE FROM agent_lifecycle_hook_packages WHERE package_id = ? AND package_version = ?', [packageId, '1.0.0']);
        if (previousPublicKey === undefined) delete process.env.AGENT_SKILL_PUBLIC_KEY;
        else process.env.AGENT_SKILL_PUBLIC_KEY = previousPublicKey;
        if (previousRequired === undefined) delete process.env.AGENT_SKILL_REQUIRE_SIGNATURE;
        else process.env.AGENT_SKILL_REQUIRE_SIGNATURE = previousRequired;
    }
});
