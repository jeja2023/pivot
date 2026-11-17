'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { canonicalJson } = require('../server/services/canonical-json');
const { verifySkillPackage } = require('../server/services/agent-skill-packages');
const { buildSignaturePayload, verifyEnvelopeSignature } = require('../server/services/agent-skill-signing');
const { assertSkillReleaseCurrent } = require('../server/services/agent-skill-resources');

test('技能包拒绝仅覆盖清单的签名，组织签名绑定正文和资源包摘要', async () => {
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
    const manifest = { id: 'signature-regression', name: 'signature-regression', version: '1.0.0' };
    const signed = { ...manifest, signature: crypto.sign('RSA-SHA256', Buffer.from(canonicalJson(manifest)), keys.privateKey).toString('base64') };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-skill-signature-'));
    try {
        const zip = new JSZip();
        zip.file('SKILL.json', JSON.stringify(signed));
        zip.file('INSTRUCTIONS.md', '替换后的正文');
        const filename = path.join(root, 'skill.zip');
        await fs.writeFile(filename, await zip.generateAsync({ type: 'nodebuffer' }));
        const checked = await verifySkillPackage(filename, { requireSignature: true, publicKey });
        assert.equal(checked.signatureValid, true);
        assert.equal(checked.valid, false);
        assert.match(checked.errors.join(' '), /未覆盖正文/);

        const options = { manifest, instructions: '原始正文', packageDigest: 'a'.repeat(64), publicKey };
        const payload = buildSignaturePayload('recipe', options);
        const envelope = { signatureForm: 'recipe', contentDigest: crypto.createHash('sha256').update(payload).digest('hex'),
            signature: crypto.sign('RSA-SHA256', Buffer.from(payload), keys.privateKey).toString('base64') };
        assert.equal(verifyEnvelopeSignature(envelope, options).verified, true);
        assert.equal(verifyEnvelopeSignature(envelope, { ...options, instructions: '替换后的正文' }).verified, false);
        assert.equal(verifyEnvelopeSignature(envelope, { ...options, packageDigest: 'b'.repeat(64) }).verified, false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('没有资源读取证据的技能任务仍复核发布、来源和正文', async () => {
    const release = { id: 3, skill_version_id: 4, name: 'demo', manifest_json: {}, instructions_md: '原始正文' };
    const run = { metadata: { skillName: 'demo', skillReleaseId: 3, skillVersionId: 4, skillInstructions: '原始正文' } };
    const deps = { resolve: async () => release, sourceActive: async () => true };
    assert.equal(await assertSkillReleaseCurrent(run, { id: 1 }, deps), release);
    await assert.rejects(() => assertSkillReleaseCurrent(run, { id: 1 }, { ...deps, resolve: async () => null }), /撤回/);
    await assert.rejects(() => assertSkillReleaseCurrent(run, { id: 1 }, { ...deps, sourceActive: async () => false }), /来源已撤回/);
    await assert.rejects(() => assertSkillReleaseCurrent({ metadata: { ...run.metadata, skillInstructions: '旧正文' } }, { id: 1 }, deps), /正文/);
});
