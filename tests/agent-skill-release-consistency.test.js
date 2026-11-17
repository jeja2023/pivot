'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { query, queryOne, execute } = require('../server/db/client');
const { createSkillVersion, validateSkillVersion, publishSkillVersion, pauseSkillRelease, rollbackSkillRelease } = require('../server/services/agent-releases');
const { listAgentSkillsForUser, getAgentSkillExecutionContext } = require('../server/services/agent-skills');
const { upsertSkillReleasePermission } = require('../server/services/agent-skill-access');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

test('灰度列表绑定真实版本，暂停和回滚保留其他发布，并发授权只产生一条记录', async () => {
    const user = await queryOne("SELECT id, role, unit FROM users WHERE username = 'admin'");
    const name = `consistency-${process.pid}-${Date.now()}`;
    const ids = [];
    const manifest = version => ({ schemaVersion: 1, id: name, name, version, capabilities: ['knowledge.search'], tools: ['rag.search'], inputs: {}, outputs: {} });
    try {
        for (const version of ['1.0.0', '2.0.0']) {
            const draft = await createSkillVersion(user, { manifest: manifest(version), instructions: `指引 ${version}`, strictSpec: true });
            ids.push(draft.id);
            assert.equal((await validateSkillVersion(draft.id, user, { strictSpec: true })).passed, true);
        }
        const first = await publishSkillVersion(ids[0], user, { scope: 'personal' });
        const second = await publishSkillVersion(ids[1], user, { scope: 'personal' });
        await execute('UPDATE agent_skill_releases SET rollout_percent=0 WHERE id=?', [second.id]);
        const skills = (await listAgentSkillsForUser(user, { includeDisabled: true })).filter(item => item.name === name);
        const current = skills.find(item => String(item.releaseId) === String(first.id));
        assert.equal(current.version, '1.0.0');
        assert.equal(Number(current.versionId), Number(ids[0]));
        assert.equal(current.status, 'enabled');
        assert.equal(skills.find(item => String(item.releaseId) === String(second.id)).status, 'disabled');
        const context = await getAgentSkillExecutionContext(user, name, { releaseId: String(first.id), version: current.version, digest: current.digest });
        assert.equal(Number(context.releaseId), Number(first.id));
        await assert.rejects(() => getAgentSkillExecutionContext(user, name, { releaseId: String(second.id), version: '2.0.0', digest: current.digest }), /变化/);

        const permission = { subjectType: 'role', subjectId: user.role, action: 'use' };
        await Promise.all(['deny', 'allow', 'deny'].map(effect => upsertSkillReleasePermission(first.id, user, { ...permission, effect })));
        const rows = await query("SELECT id FROM resource_permissions WHERE resource_type='skill_release' AND resource_id=? AND subject_type='role' AND subject_id=? AND action='use'", [String(first.id), user.role]);
        assert.equal(rows.length, 1);
        await execute("DELETE FROM resource_permissions WHERE resource_type='skill_release' AND resource_id=?", [String(first.id)]);

        await rollbackSkillRelease(second.id, user);
        assert.equal((await queryOne('SELECT version, status FROM agent_skills WHERE name=?', [name])).version, '1.0.0');
        await pauseSkillRelease(first.id, user);
        assert.equal((await queryOne('SELECT status FROM agent_skills WHERE name=?', [name])).status, 'disabled');
        assert.equal((await listAgentSkillsForUser(user)).some(item => item.name === name), false);
    } finally {
        await execute("DELETE FROM resource_permissions WHERE resource_type='skill_release' AND resource_id IN (SELECT id::text FROM agent_skill_releases WHERE name=?)", [name]);
        await execute('DELETE FROM agent_skill_releases WHERE name=?', [name]);
        await execute('DELETE FROM agent_skill_validations WHERE skill_version_id IN (SELECT id FROM agent_skill_versions WHERE name=?)', [name]);
        await execute('DELETE FROM agent_skills WHERE name=?', [name]);
        await execute('DELETE FROM agent_skill_versions WHERE name=?', [name]);
    }
});

test('技能版本和验证接口忽略调用方提供的服务端路径及隔离参数', async () => {
    const user = await queryOne("SELECT id, role, unit FROM users WHERE username = 'admin'");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-skill-route-'));
    const name = `route-skill-${process.pid}-${Date.now()}`;
    const app = express();
    app.use(express.json());
    app.use('/api', require('../server/routes/agent-control-plane').createAgentControlPlaneRouter({ authMiddleware: (req, _res, next) => { req.user = user; next(); } }));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/agents/skills/versions`;
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
        const manifest = { schemaVersion: 1, id: name, name, version: '1.0.0', capabilities: ['knowledge.search'], tools: ['rag.search'], inputs: {}, outputs: {} };
        const response = await post(base, { manifest, instructions: '执行说明', packageRoot: root, publicKey: '自选密钥' });
        assert.equal(response.status, 201);
        const version = (await response.json()).version;
        assert.equal(version.package_path, '');
        const validated = await post(`${base}/${version.id}/validate`, { workspaceRoot: root, strictIsolation: false });
        assert.equal(validated.status, 200, JSON.stringify(await validated.json()));
        assert.deepEqual(await fs.readdir(root), []);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await execute('DELETE FROM agent_skill_validations WHERE skill_version_id IN (SELECT id FROM agent_skill_versions WHERE name=?)', [name]);
        await execute('DELETE FROM agent_skill_versions WHERE name=?', [name]);
        await fs.rm(root, { recursive: true, force: true });
    }
});
