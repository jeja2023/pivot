'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'pivot-skill-discovery-test-secret-012345678901234567890123';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { authMiddleware, login, register } = require('../server/auth');
const { execute } = require('../server/db/client');
const { createAgentsRouter } = require('../server/routes/agents');
const { createSkillVersion, pauseSkillRelease, publishSkillVersion, validateSkillVersion } = require('../server/services/agent-releases');
const { canonicalJson } = require('../server/services/agent-skills');

test('skill discovery HTTP routes enforce authentication and current release visibility', async () => {
    const suffix = `${process.pid}${Date.now()}`;
    const username = `skill_http_${suffix}`;
    const password = 'DiscoveryPass123';
    const user = await register(username, password, '技能发现测试', 'QA', 'user');
    const session = await login(username, password, { clientIp: '127.0.0.1' });
    const name = `HTTP技能-${suffix}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-skill-http-'));
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const manifest = { schemaVersion: 1, id: `http.skill.${suffix}`, name, version: '1.0.0', title: name, tags: ['财务'], capabilities: ['knowledge.search'], tools: ['rag.search'], inputs: {}, outputs: {} };
    const signer = crypto.createSign('RSA-SHA256'); signer.update(canonicalJson(manifest)); signer.end();
    manifest.signature = signer.sign(privateKey).toString('base64');
    const app = express();
    app.use(express.json());
    app.use('/api', createAgentsRouter({ authMiddleware, logAction: () => {} }));
    app.use((error, _req, res, _next) => res.status(error.status || error.statusCode || 500).json({ error: error.message, code: error.code }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/agents/skills/discovery`;
    const headers = { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' };
    try {
        const publicKeyPem = publicKey.export({ type: 'pkcs1', format: 'pem' });
        const version = await createSkillVersion(user, { manifest, packageRoot: root, publicKey: publicKeyPem, requireSignature: true });
        assert.equal((await validateSkillVersion(version.id, user, { publicKey: publicKeyPem, testTimeoutMs: 10000 })).passed, true);
        const release = await publishSkillVersion(version.id, user, { scope: 'personal' });
        assert.equal((await fetch(base)).status, 401);
        const found = await fetch(`${base}?query=${encodeURIComponent(name)}&domain=${encodeURIComponent('财务')}`, { headers });
        assert.equal(found.status, 200);
        const reference = (await found.json()).data.candidates[0].reference;
        const describe = ref => fetch(`${base}/describe`, { method: 'POST', headers, body: JSON.stringify({ reference: ref }) });
        assert.equal((await describe(reference)).status, 200);
        const stale = await describe({ ...reference, digest: 'stale' });
        assert.equal(stale.status, 409);
        assert.equal((await stale.json()).code, 'SKILL_REFERENCE_STALE');
        assert.ok(await pauseSkillRelease(release.id, user, 'HTTP 发现测试'));
        assert.equal((await describe(reference)).status, 404);
        const after = await fetch(`${base}?query=${encodeURIComponent(name)}`, { headers });
        assert.equal((await after.json()).data.total, 0);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await execute('DELETE FROM agent_skill_releases WHERE name = ?', [name]);
        await execute('DELETE FROM agent_skill_validations WHERE skill_version_id IN (SELECT id FROM agent_skill_versions WHERE name = ?)', [name]);
        await execute('DELETE FROM agent_skills WHERE name = ?', [name]);
        await execute('DELETE FROM agent_skill_versions WHERE name = ?', [name]);
        await execute('DELETE FROM refresh_tokens WHERE user_id = ?', [user.id]);
        await execute('DELETE FROM users WHERE id = ?', [user.id]);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
