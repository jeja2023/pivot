'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { queryOne, execute } = require('../server/db/client');
const { canonicalJson } = require('../server/services/agent-skills');
const {
    createSkillVersion,
    publishSkillVersion,
    resolvePublishedSkillMemorySource,
    validateSkillVersion
} = require('../server/services/agent-releases');
const { attachMemorySourceEvidence, approveMemorySourceReview, updateMemoryStatus } = require('../server/services/long-term-memory');

const FINGERPRINT_SECRET = 'pivot-skill-memory-source-test-secret-01234567890123456789';

function signedManifest({ skillId, name, version, privateKey }) {
    const manifest = {
        schemaVersion: 1, id: skillId, name, version, title: '来源失效测试技能',
        capabilities: ['knowledge.search'], tools: ['rag.search'], inputs: {}, outputs: {}
    };
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(canonicalJson(manifest));
    signer.end();
    manifest.signature = signer.sign(privateKey).toString('base64');
    return manifest;
}

test('技能发布新版本会使关联记忆待复核，并基于稳定技能 ID 复核当前版本', async () => {
    const previous = process.env.PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET;
    process.env.PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET = FINGERPRINT_SECRET;
    const user = await queryOne('SELECT id, username, role, unit FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const skillId = `memory.skill.${suffix}`;
    const name = `记忆来源技能-${suffix}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-memory-skill-'));
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKeyPem = publicKey.export({ type: 'pkcs1', format: 'pem' });
    let memoryId;
    try {
        const first = await createSkillVersion(user, {
            manifest: signedManifest({ skillId, name, version: '1.0.0', privateKey }),
            packageRoot: root, publicKey: publicKeyPem, requireSignature: true
        });
        assert.equal((await validateSkillVersion(first.id, user, { publicKey: publicKeyPem, testTimeoutMs: 10000 })).passed, true);
        await publishSkillVersion(first.id, user, { scope: 'personal' });
        const memory = await queryOne(`
            INSERT INTO memories (user_id, type, content, origin, status, created_at, updated_at)
            VALUES (?, 'fact', ?, 'explicit', 'active', NOW(), NOW()) RETURNING id
        `, [user.id, `技能来源隔离回归-${suffix}`]);
        memoryId = Number(memory.id);
        const initial = await resolvePublishedSkillMemorySource(skillId, user);
        await attachMemorySourceEvidence(user.id, memoryId, {
            sourceKind: 'agent_skill', sourceRef: `agent_skill:${initial.skillId}`,
            sourceContent: initial.content, sourceVersion: String(initial.versionId), evidenceExcerpt: initial.name
        });

        const second = await createSkillVersion(user, {
            manifest: signedManifest({ skillId, name, version: '1.0.1', privateKey }),
            packageRoot: root, publicKey: publicKeyPem, requireSignature: true
        });
        assert.equal((await validateSkillVersion(second.id, user, { publicKey: publicKeyPem, testTimeoutMs: 10000 })).passed, true);
        await publishSkillVersion(second.id, user, { scope: 'personal' });
        assert.equal((await queryOne('SELECT status FROM memories WHERE id = ?', [memoryId])).status, 'review_required');
        await assert.rejects(
            () => updateMemoryStatus(user.id, memoryId, 'active'),
            error => error.code === 'MEMORY_SOURCE_REVIEW_REQUIRED'
        );
        const latest = await resolvePublishedSkillMemorySource(skillId, user);
        const reviewed = await approveMemorySourceReview(user.id, memoryId, {
            sourceKind: 'agent_skill', sourceRef: `agent_skill:${latest.skillId}`,
            sourceContent: latest.content, sourceVersion: String(latest.versionId)
        });
        assert.equal(reviewed.activated, true);
        assert.equal((await queryOne('SELECT status FROM memories WHERE id = ?', [memoryId])).status, 'active');
    } finally {
        if (memoryId) await execute('DELETE FROM memories WHERE id = ?', [memoryId]);
        await execute('DELETE FROM agent_skill_releases WHERE name = ?', [name]);
        await execute('DELETE FROM agent_skill_validations WHERE skill_version_id IN (SELECT id FROM agent_skill_versions WHERE name = ?)', [name]);
        await execute('DELETE FROM agent_skills WHERE name = ?', [name]);
        await execute('DELETE FROM agent_skill_versions WHERE name = ?', [name]);
        fs.rmSync(root, { recursive: true, force: true });
        if (previous === undefined) delete process.env.PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET;
        else process.env.PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET = previous;
    }
});
