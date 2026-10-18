'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { canonicalJson } = require('../server/services/agent-skills');
const { createSkillVersion, pauseSkillRelease, publishSkillVersion, validateSkillVersion } = require('../server/services/agent-releases');
const { deleteSkillReleasePermission, upsertSkillReleasePermission } = require('../server/services/agent-skill-access');
const { describeSkillForUser, searchSkillsForUser } = require('../server/services/agent-skill-discovery');

test('published skill discovery follows real ACL, rollout and pause changes', async () => {
    const user = await queryOne("SELECT id, username, role, unit FROM users WHERE role IN ('admin', 'root') ORDER BY id LIMIT 1");
    assert.ok(user);
    const suffix = `${process.pid}-${Date.now()}`;
    const name = `发现验收技能-${suffix}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-skill-discovery-'));
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const manifest = { schemaVersion: 1, id: `discovery.skill.${suffix}`, name, version: '1.0.0', title: name, tags: ['财务'], capabilities: ['knowledge.search'], tools: ['rag.search'], inputs: {}, outputs: {} };
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(canonicalJson(manifest)); signer.end();
    manifest.signature = signer.sign(privateKey).toString('base64');
    let release;
    let sharedRelease;
    const createdUsers = [];
    const createdOrganizations = [];
    try {
        const version = await createSkillVersion(user, { manifest, packageRoot: root, publicKey: publicKey.export({ type: 'pkcs1', format: 'pem' }), requireSignature: true });
        assert.equal((await validateSkillVersion(version.id, user, { publicKey: publicKey.export({ type: 'pkcs1', format: 'pem' }), testTimeoutMs: 10000 })).passed, true);
        release = await publishSkillVersion(version.id, user, { scope: 'personal' });
        const found = await searchSkillsForUser(user, { query: name, domain: '财务', capability: 'knowledge.search' });
        assert.equal(found.total, 1);
        const reference = found.candidates[0].reference;
        assert.equal((await describeSkillForUser(user, reference)).reference.releaseId, String(release.id));
        const stranger = { id: 2147483000, role: 'user' };
        assert.equal((await searchSkillsForUser(stranger, { query: name })).total, 0);
        await assert.rejects(() => describeSkillForUser(stranger, reference), error => error.code === 'SKILL_NOT_AVAILABLE');
        for (const label of ['a', 'b']) {
            const organization = await queryOne("INSERT INTO organizations (name, slug, status) VALUES (?, ?, 'active') RETURNING id", [`发现测试 ${label} ${suffix}`, `discovery-${label}-${suffix}`]);
            const member = await queryOne("INSERT INTO users (username, password_hash, role, status) VALUES (?, 'hash', 'user', 'active') RETURNING id, role", [`discovery_${label}_${suffix}`]);
            createdOrganizations.push(organization.id);
            createdUsers.push({ ...member, tenant_id: organization.id });
        }
        // 仅作为隔离测试夹具直接写入组织范围发布；不代表组织签名或发布门禁通过。
        sharedRelease = await queryOne(`INSERT INTO agent_skill_releases
            (skill_version_id, owner_key, name, tenant_id, rollout_scope, rollout_percent, status, published_by)
            VALUES (?, ?, ?, ?, 'organization', 100, 'published', ?) RETURNING id`,
        [version.id, `org:${createdOrganizations[0]}`, name, createdOrganizations[0], user.id]);
        const shared = await searchSkillsForUser(createdUsers[0], { query: name });
        assert.equal(shared.total, 1);
        assert.equal(shared.candidates[0].reference.releaseId, String(sharedRelease.id));
        assert.equal((await describeSkillForUser(createdUsers[0], shared.candidates[0].reference)).reference.name, name);
        assert.equal((await searchSkillsForUser(createdUsers[1], { query: name })).total, 0);
        await assert.rejects(() => describeSkillForUser(createdUsers[1], shared.candidates[0].reference), error => error.code === 'SKILL_NOT_AVAILABLE');
        const denied = await upsertSkillReleasePermission(release.id, user, { subjectType: 'role', subjectId: user.role, action: 'use', effect: 'deny' });
        assert.equal((await searchSkillsForUser(user, { query: name })).total, 0);
        await assert.rejects(() => describeSkillForUser(user, reference), error => error.code === 'SKILL_NOT_AVAILABLE');
        await deleteSkillReleasePermission(release.id, denied.id, user);
        assert.equal((await searchSkillsForUser(user, { query: name })).total, 1);
        await execute('UPDATE agent_skill_releases SET rollout_percent = 0 WHERE id = ?', [release.id]);
        assert.equal((await searchSkillsForUser(user, { query: name })).total, 0);
        await assert.rejects(() => describeSkillForUser(user, reference), error => error.code === 'SKILL_NOT_AVAILABLE');
        await execute('UPDATE agent_skill_releases SET rollout_percent = 100 WHERE id = ?', [release.id]);
        assert.ok(await pauseSkillRelease(release.id, user, '发现验收测试'));
        assert.equal((await searchSkillsForUser(user, { query: name })).total, 0);
        await assert.rejects(() => describeSkillForUser(user, reference), error => error.code === 'SKILL_NOT_AVAILABLE');
    } finally {
        if (release) await execute("DELETE FROM resource_permissions WHERE resource_type = 'skill_release' AND resource_id = ?", [String(release.id)]);
        await execute('DELETE FROM agent_skill_releases WHERE name = ?', [name]);
        await execute('DELETE FROM agent_skill_validations WHERE skill_version_id IN (SELECT id FROM agent_skill_versions WHERE name = ?)', [name]);
        await execute('DELETE FROM agent_skills WHERE name = ?', [name]);
        await execute('DELETE FROM agent_skill_versions WHERE name = ?', [name]);
        for (const member of createdUsers) await execute('DELETE FROM users WHERE id = ?', [member.id]);
        for (const organizationId of createdOrganizations) await execute('DELETE FROM organizations WHERE id = ?', [organizationId]);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
