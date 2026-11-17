'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { queryOne, execute } = require('../server/db/client');
const { prepareSkillImport } = require('../server/services/agent-skill-import-assistant');
const authoring = require('../server/services/agent-skill-authoring');
const releases = require('../server/services/agent-releases');
const resources = require('../server/services/agent-skill-resources');
const { buildSkillSourceMarkdown, parseSkillSourceMarkdown } = require('../server/services/agent-skill-source');

function configureSigning(t) {
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const signingEnvironment = { AGENT_SKILL_ORGANIZATION_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        AGENT_SKILL_ORGANIZATION_PRIVATE_KEY_BASE64: '', AGENT_SKILL_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }), AGENT_SKILL_ORGANIZATION_KEY_ID: crypto.randomUUID() };
    const previousEnvironment = Object.fromEntries(Object.keys(signingEnvironment).map(key => [key, process.env[key]]));
    Object.assign(process.env, signingEnvironment);
    t.after(() => { for (const [key, value] of Object.entries(previousEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    return keys;
}

test('资源技能修订经来源版本和摘要授权，保留任务来源与资源，拒绝撤权和篡改', async t => {
    configureSigning(t);
    const user = await queryOne("SELECT id,role,unit FROM users WHERE username='admin'");
    const stranger = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES(?,'hash','user','active') RETURNING id,role", [`revision_${crypto.randomUUID()}`]);
    const runId = crypto.randomUUID(), ids = [], names = [];
    let envelopeId;
    await execute("INSERT INTO agent_runs(id,user_id,title,goal,status) VALUES(?,?,'来源任务','资料校验','completed')", [runId, user.id]);
    t.after(async () => {
        for (const name of names) {
            await execute('DELETE FROM agent_skill_releases WHERE name=?', [name]);
            await execute('DELETE FROM agent_skills WHERE name=?', [name]);
        }
        for (const id of ids) {
            await execute("DELETE FROM resource_permissions WHERE resource_type='skill_version' AND resource_id=?", [String(id)]);
            await execute('DELETE FROM agent_skill_versions WHERE id=?', [id]);
        }
        await execute('DELETE FROM agent_runs WHERE id=?', [runId]);
        await execute('DELETE FROM users WHERE id=?', [stranger.id]);
        if (envelopeId) await execute('DELETE FROM agent_skill_signing_envelopes WHERE id=?', [envelopeId]);
    });
    const input = { markdown: '# 指引\n按 references/rules.md 处理。', title: '资源修订回归', tools: ['skill.resources', 'skill.read_resource'],
        resources: [{ path: 'references/rules.md', content: '金额保留两位小数' },
            { path: 'assets/example.png', encoding: 'base64', content: (await require('sharp')({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer()).toString('base64') }] };
    const proposal = prepareSkillImport(input, resources.definitions());
    const original = (await authoring.createSkillVersionFromMarkdown(user, { markdown: proposal.markdown, resources: input.resources, sourceRunId: runId })).version;
    ids.push(original.id); names.push(original.name);
    assert.equal((await releases.validateSkillVersion(original.id, user)).passed, true);
    envelopeId = (await releases.approveSkillVersionForSharing(original.id, user)).envelope.id;
    await releases.publishSkillVersion(original.id, user, { scope: 'personal' });
    const source = await authoring.exportSkillVersionMarkdown(user, original.id);
    const parsed = parseSkillSourceMarkdown(source.markdown);
    const markdown = buildSkillSourceMarkdown({ ...parsed.manifest, version: '1.0.1' }, parsed.instructions + '\n复核后再交付。');
    const revision = { markdown, sourceVersionId: original.id, sourceDigest: source.version.digest };
    assert.equal(authoring.previewSkillSource(markdown).valid, true);
    await assert.rejects(() => authoring.createSkillVersionFromMarkdown(stranger, revision), error => error.status === 403);
    await assert.rejects(() => authoring.createSkillVersionFromMarkdown(user, { ...revision, sourceDigest: 'stale' }), /已变化/);
    await assert.rejects(() => authoring.createSkillVersionFromMarkdown(user, { ...revision, sourceVersionId: '../outside' }), error => error.status === 400);
    const app = express(); app.use(express.json());
    app.use('/api', require('../server/routes/agent-control-plane').createAgentControlPlaneRouter({ authMiddleware: (req, _res, next) => { req.user = user; next(); } }));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agents/skills/source`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(revision) });
    const created = await response.json(); assert.equal(response.status, 201, JSON.stringify(created));
    const revised = created.version; ids.push(revised.id);
    assert.equal(revised.source_run_id, runId); assert.equal(revised.status, 'draft'); assert.equal(revised.signing_envelope_id, null);
    assert.notEqual(revised.package_path, original.package_path);
    const oldPack = await resources.readInstalledSkillResources(original.package_path), newPack = await resources.readInstalledSkillResources(revised.package_path);
    for (const name of ['references/rules.md', 'assets/example.png']) assert.deepEqual(newPack.entries.find(item => item.name === name).data, oldPack.entries.find(item => item.name === name).data);
    assert.equal((await authoring.exportSkillVersionMarkdown(user, original.id)).markdown, source.markdown);
    assert.equal((await releases.validateSkillVersion(revised.id, user)).passed, true);
    const release = await releases.publishSkillVersion(revised.id, user, { scope: 'personal' });
    const context = { run: { metadata: { skillName: revised.name, skillVersionId: revised.id, skillReleaseId: release.id } } };
    assert.equal((await resources.execute('skill.read_resource', { path: 'references/rules.md' }, user, context)).text, '金额保留两位小数');

    const next = { ...revision, markdown: markdown.replace('version: 1.0.1', 'version: 1.0.2') };
    await execute("INSERT INTO resource_permissions(subject_type,subject_id,resource_type,resource_id,action,effect,conditions_json) VALUES('user',?,'skill_version',?,'write','deny','{}')", [String(user.id), String(original.id)]);
    await assert.rejects(() => authoring.createSkillVersionFromMarkdown(user, next), /无权编辑/);
    await execute("DELETE FROM resource_permissions WHERE resource_type='skill_version' AND resource_id=?", [String(original.id)]);
    await execute('UPDATE agent_runs SET deleted_at=NOW() WHERE id=?', [runId]);
    await assert.rejects(() => authoring.createSkillVersionFromMarkdown(user, next), /来源任务已撤回/);
    await assert.rejects(() => require('../server/services/agent-skills').getAgentSkillExecutionContext(user, revised.name), /来源已撤回/);
    await execute('UPDATE agent_runs SET deleted_at=NULL WHERE id=?', [runId]);
    await require('../server/services/agent-skill-signing').revokeSigningEnvelope(envelopeId);
    await assert.rejects(() => authoring.createSkillVersionFromMarkdown(user, next), /签名已失效/);
    await fs.writeFile(path.join(original.package_path, 'references/rules.md'), '被篡改的内容');
    await assert.rejects(() => authoring.createSkillVersionFromMarkdown(user, next), /摘要不匹配/);
});

test('只含指引的已签名包仍可编辑为新草稿，原签名撤回后拒绝继续复制', async t => {
    const keys = configureSigning(t), packages = require('../server/services/agent-skill-packages');
    const user = await queryOne("SELECT id,role FROM users WHERE username='admin'");
    const name = `recipe-revision-${crypto.randomUUID()}`, ids = [];
    const temp = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'pivot-recipe-revision-'));
    let envelopeId;
    t.after(async () => {
        for (const id of ids) await execute('DELETE FROM agent_skill_versions WHERE id=?', [id]);
        if (envelopeId) await execute('DELETE FROM agent_skill_signing_envelopes WHERE id=?', [envelopeId]);
        await fs.rm(temp, { recursive: true, force: true });
    });
    const manifest = { schemaVersion: 1, id: name, name, version: '1.0.0', capabilities: ['knowledge.search'], tools: ['rag.search'], inputs: {}, outputs: {} };
    const markdown = buildSkillSourceMarkdown(manifest, '完整工作指引。');
    const digest = packages.packageDigest([{ name: 'SKILL.md', data: Buffer.from(markdown) }]);
    const signature = crypto.sign('RSA-SHA256', Buffer.from(digest), keys.privateKey).toString('base64');
    const zip = new (require('jszip'))(); zip.file('SKILL.md', markdown); zip.file('SKILL.sig', signature);
    const file = path.join(temp, 'skill.zip'); await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const installed = await packages.installSkillPackage(file, { requireSignature: true, publicKey: process.env.AGENT_SKILL_PUBLIC_KEY });
    const original = await releases.createSkillVersion(user, { manifest, instructions: parseSkillSourceMarkdown(markdown).instructions, packageRoot: installed.installDir,
        packageDigest: digest, packageSignature: signature, requireSignature: true, publicKey: process.env.AGENT_SKILL_PUBLIC_KEY });
    ids.push(original.id); envelopeId = original.signing_envelope_id;
    assert.equal((await releases.validateSkillVersion(original.id, user)).passed, true);
    const input = { markdown: markdown.replace('version: 1.0.0', 'version: 1.0.1'), sourceVersionId: original.id, sourceDigest: original.digest };
    const revised = (await authoring.createSkillVersionFromMarkdown(user, input)).version; ids.push(revised.id);
    assert.equal(revised.package_path, ''); assert.equal(revised.signing_envelope_id, null); assert.equal(revised.status, 'draft');
    await require('../server/services/agent-skill-signing').revokeSigningEnvelope(envelopeId);
    await assert.rejects(() => authoring.createSkillVersionFromMarkdown(user, { ...input, markdown: markdown.replace('version: 1.0.0', 'version: 1.0.2') }), /签名已失效/);
});
