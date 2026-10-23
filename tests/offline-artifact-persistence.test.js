'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { queryOne, execute } = require('../server/db/client');
const { materializeToolArtifact } = require('../server/services/tool-result-artifacts');
const { issueDownloadToken, consumeDownloadToken, getRenditionForUser } = require('../server/services/agent-artifact-renditions');

test('签名 ZIP 正文持久化，预览不能代替完整验证，验证后才可发布', async () => {
    const fs = require('node:fs/promises'); const os = require('node:os'); const path = require('node:path');
    const crypto = require('node:crypto'); const Zip = require('jszip');
    const { readSkillPackage, installSkillPackage } = require('../server/services/agent-skill-packages');
    const { createSkillVersion, validateSkillVersion, publishSkillVersion } = require('../server/services/agent-releases');
    const user = await queryOne('SELECT id, username, role FROM users ORDER BY id LIMIT 1');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-signed-skill-'));
    const file = path.join(root, 'recipe.skill.zip');
    const name = `offline-recipe-${Date.now()}`;
    const markdown = `---\nschemaVersion: 1\nid: ${name}\nname: ${name}\nversion: 1.0.0\ncapabilities: [knowledge.search]\ntools: [rag.search]\ninputs: {}\noutputs: {}\n---\n\n只检索当前用户已授权的资料。\n`;
    const zip = new Zip().file('SKILL.md', markdown);
    try {
        await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
        const unsigned = await readSkillPackage(file);
        const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
        zip.file('SKILL.sig', crypto.sign('RSA-SHA256', Buffer.from(unsigned.digest), keys.privateKey).toString('base64'));
        await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
        const pack = await installSkillPackage(file, { requireSignature: true, publicKey, installRoot: path.join(root, 'installed') });
        const version = await createSkillVersion(user, { manifest: pack.manifest.manifest, instructions: pack.package.instructions, packageRoot: pack.installDir,
            packageSignature: pack.package.signature, packageDigest: pack.package.digest, publicKey, requireSignature: true, strictSpec: true });
        assert.equal(version.instructions_md.trim(), '只检索当前用户已授权的资料。');
        await assert.rejects(publishSkillVersion(version.id, user, { rolloutScope: 'personal' }), error => error.code === 'SKILL_RELEASE_GATE_FAILED');
        const validation = await validateSkillVersion(version.id, user, { publicKey, requireSignature: true, strictIsolation: false });
        assert.equal(validation.passed, true, JSON.stringify(validation));
        const release = await publishSkillVersion(version.id, user, { rolloutScope: 'personal' });
        assert.equal(release.status, 'published');
    } finally {
        await execute('DELETE FROM agent_skill_releases WHERE name = ?', [name]);
        await execute('DELETE FROM agent_skills WHERE name = ?', [name]);
        await execute('DELETE FROM agent_skill_versions WHERE name = ?', [name]);
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('真实工具结果经 IR 和 CAS 生成可授权下载的报告与图形', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    for (const envelope of [
        { kind: 'audit', data: { status: 'completed', issues: [{ line: 2, column: 1, target: 'os.system', risk: 'high', description: '执行命令' }] } },
        { kind: 'diagram', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>' }
    ]) {
        const result = await materializeToolArtifact({ structuredContent: { pivotArtifact: envelope } }, user, { stepId: `offline-test:${envelope.kind}` });
        try {
            assert.ok(result.artifactId); assert.ok(result.renditionId); assert.equal(result.contentDigest.length, 64);
            assert.equal(await getRenditionForUser(result.renditionId, { id: Number(user.id) + 999999 }), null);
            const token = await issueDownloadToken(user, result.renditionId);
            const consumed = await consumeDownloadToken(user, token.token);
            assert.ok(consumed);
            await assert.rejects(consumeDownloadToken(user, token.token), error => error.code === 'ARTIFACT_DOWNLOAD_TOKEN_INVALID');
        } finally { await execute('DELETE FROM agent_artifacts WHERE id = ?', [result.artifactId]); }
    }
});
