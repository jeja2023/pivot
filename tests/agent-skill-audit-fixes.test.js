'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { queryOne, execute } = require('../server/db/client');
const releases = require('../server/services/agent-releases');
const skills = require('../server/services/agent-skills');
const access = require('../server/services/agent-skill-access');
const { previewSkillSource } = require('../server/services/agent-skill-authoring');

function setEnvironment(t, values) {
    const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values);
    t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

async function fixture(t) {
    setEnvironment(t, { PIVOT_ENTERPRISE_ACCESS: 'false' });
    const users = [];
    t.after(async () => {
        for (const user of users) {
            await execute("DELETE FROM resource_permissions WHERE resource_type='skill_release' AND resource_id IN (SELECT id::text FROM agent_skill_releases WHERE published_by=?)", [user.id]);
            await execute('DELETE FROM agent_runs WHERE user_id=?', [user.id]);
            await execute('DELETE FROM agent_skill_releases WHERE published_by=?', [user.id]);
        }
        for (const user of users) {
            await execute('DELETE FROM agent_skills WHERE user_id=?', [user.id]);
            await execute('DELETE FROM agent_skill_versions WHERE created_by=?', [user.id]);
            await execute('DELETE FROM users WHERE id=?', [user.id]);
        }
    });
    const user = async (role = 'user') => {
        const row = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES(?,'hash',?,'active') RETURNING id,role,username", [`skill_fix_${crypto.randomUUID()}`, role]);
        users.push(row); return row;
    };
    const manifest = (name, extra = {}) => ({ schemaVersion: 1, id: name, name, version: '1.0.0',
        capabilities: ['knowledge.search'], tools: ['rag.search'], inputs: {}, outputs: {}, ...extra });
    const version = async (owner, name = `skill-fix-${crypto.randomUUID()}`, extra = {}) => {
        const draft = await releases.createSkillVersion(owner, { manifest: manifest(name, extra), instructions: '按当前授权资料工作。', strictSpec: true });
        assert.equal((await releases.validateSkillVersion(draft.id, owner, { strictSpec: true })).passed, true);
        return draft;
    };
    return { user, manifest, version };
}

test('个人技能拒绝新增共享 ACL，历史授权也不能绕过目录、执行和资源边界', async t => {
    const f = await fixture(t), owner = await f.user(), recipient = await f.user();
    const version = await f.version(owner), release = await releases.publishSkillVersion(version.id, owner, { scope: 'personal' });
    const team = await queryOne("INSERT INTO teams(organization_id,name,slug,status) VALUES(1,?,?,'active') RETURNING id", ['技能授权测试', crypto.randomUUID()]);
    await execute("INSERT INTO team_members(team_id,user_id,role,status) VALUES(?,?,'member','active')", [team.id, recipient.id]);
    t.after(() => execute('DELETE FROM teams WHERE id=?', [team.id]));
    const app = express(); app.use(express.json());
    app.use('/api', require('../server/routes/agent-control-plane').createAgentControlPlaneRouter({ authMiddleware: (req, _res, next) => { req.user = owner; next(); } }));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code }));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const subjects = [['user', String(recipient.id)], ['role', 'user'], ['organization', '1'], ['team', String(team.id)]];
    for (const [subjectType, subjectId] of subjects) {
        for (const action of ['use', 'publish', 'manage']) {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/agents/skills/releases/${release.id}/permissions`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subjectType, subjectId, action, effect: 'allow' })
            });
            assert.equal(response.status, 409); assert.equal((await response.json()).code, 'SKILL_PERSONAL_SHARING_FORBIDDEN');
        }
        // 模拟升级前已经存在的个人范围共享授权，不通过新写入入口制造此状态。
        await execute("INSERT INTO resource_permissions(subject_type,subject_id,resource_type,resource_id,action,effect,conditions_json) VALUES(?,?,'skill_release',?,'manage','allow','{}')", [subjectType, subjectId, String(release.id)]);
        for (const action of ['use', 'publish', 'manage']) assert.equal((await access.evaluateSkillReleaseAccess({ user: recipient, release, action })).allowed, false);
        assert.equal(await releases.resolvePublishedSkill(version.name, recipient), null);
        assert.equal((await releases.listSkillCatalogForUser(recipient, { all: true, useOnly: true })).some(row => String(row.id) === String(release.id)), false);
        await assert.rejects(() => skills.getAgentSkillExecutionContext(recipient, version.name), /没有可用|不存在/);
        await assert.rejects(() => require('../server/services/agent-skill-resources').execute('skill.resources', {}, recipient, {
            run: { metadata: { skillName: version.name, skillVersionId: version.id, skillReleaseId: release.id } }
        }), /撤回/);
        await execute("DELETE FROM resource_permissions WHERE resource_type='skill_release' AND resource_id=?", [String(release.id)]);
    }
    assert.equal(String((await skills.getAgentSkillExecutionContext(owner, version.name)).releaseId), String(release.id));
    await access.upsertSkillReleasePermission(release.id, owner, { subjectType: 'user', subjectId: String(owner.id), action: 'use', effect: 'allow' });
    const denied = await access.upsertSkillReleasePermission(release.id, owner, { subjectType: 'user', subjectId: String(owner.id), action: 'use', effect: 'deny' });
    assert.equal(await releases.resolvePublishedSkill(version.name, owner), null);
    await access.deleteSkillReleasePermission(release.id, denied.id, owner);
});

test('默认单租户账号无需伪造租户字段即可签名共享、治理和授权，企业模式仍拒绝无归属用户', async t => {
    const f = await fixture(t), owner = await f.user(), recipient = await f.user(), admin = await f.user('admin');
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    setEnvironment(t, { AGENT_SKILL_ORGANIZATION_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        AGENT_SKILL_ORGANIZATION_PRIVATE_KEY_BASE64: '', AGENT_SKILL_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }), AGENT_SKILL_ORGANIZATION_KEY_ID: crypto.randomUUID() });
    assert.deepEqual((await access.resolveAccessSubjects(admin)).organizationIds, [1]);
    assert.deepEqual((await access.resolveAccessSubjects({ role: 'user' })).organizationIds, []);
    const version = await f.version(owner);
    assert.ok(await releases.getSkillVersion(version.id, admin, { action: 'manage' }));
    const release = await releases.publishSkillVersion(version.id, admin, { scope: 'organization' });
    assert.equal(release.autoApproved, true);
    assert.equal(String((await skills.getAgentSkillExecutionContext(recipient, version.name)).releaseId), String(release.id));
    const denied = await access.upsertSkillReleasePermission(release.id, admin, { subjectType: 'user', subjectId: String(recipient.id), action: 'use', effect: 'deny' });
    assert.equal(await releases.resolvePublishedSkill(version.name, recipient), null);
    await access.deleteSkillReleasePermission(release.id, denied.id, admin);
    await assert.rejects(() => access.upsertSkillReleasePermission(release.id, admin, { subjectType: 'user', subjectId: '2147483000', action: 'use' }), /当前技能租户/);
    assert.equal((await access.evaluateSkillReleaseAccess({ user: { ...recipient, tenant_id: 99999 }, release })).allowed, false);
    process.env.PIVOT_ENTERPRISE_ACCESS = 'true';
    assert.deepEqual((await access.resolveAccessSubjects(recipient)).organizationIds, []);
    assert.equal(await releases.resolvePublishedSkill(version.name, recipient), null);
    assert.equal(await releases.getSkillVersion(version.id, admin, { action: 'manage' }), null);
});

test('异常标签在新建时拒绝，历史异常条目不会阻断自动匹配', async t => {
    const f = await fixture(t), owner = await f.user(), name = `tags-${crypto.randomUUID()}`;
    for (const tags of ['财务', {}, null, [1], [' '], ['长'.repeat(101)], Array(101).fill('标签')]) {
        const manifest = f.manifest(name, { tags });
        assert.equal(skills.validateSkillManifest(manifest, { strictSpec: true }).valid, false);
        assert.equal(previewSkillSource(`---\n${JSON.stringify(manifest)}\n---\n工作指引`).valid, false);
        await assert.rejects(() => releases.createSkillVersion(owner, { manifest, strictSpec: true }), /tags/);
    }
    const good = await f.version(owner, name, { title: '财务核对', tags: ['财务核对'] });
    const goodRelease = await releases.publishSkillVersion(good.id, owner, { scope: 'personal' });
    const badName = `bad-${crypto.randomUUID()}`, badManifest = f.manifest(badName, { title: '财务核对', tags: '财务' });
    // 直接构造升级前的发布记录，验证消费者不会再选择该历史异常版本。
    const bad = await queryOne(`INSERT INTO agent_skill_versions(skill_id,owner_key,name,version,digest,manifest_yaml,manifest_json,instructions_md,tenant_id,status,created_by)
        VALUES(?,?,?,'1.0.0','sha256:legacy',?,?::jsonb,'旧版指引',1,'published',?) RETURNING id`, [badName, `user:${owner.id}`, badName, JSON.stringify(badManifest), JSON.stringify(badManifest), owner.id]);
    await execute("INSERT INTO agent_skill_releases(skill_version_id,owner_key,name,tenant_id,rollout_scope,status,published_by) VALUES(?,?,?,1,'personal','published',?)", [bad.id, `user:${owner.id}`, badName, owner.id]);
    assert.equal(await skills.findBestPersonalSkill(owner, '完全无关的目标'), null);
    assert.equal(String((await skills.findBestPersonalSkill(owner, '财务核对')).id), String(goodRelease.id));
});

test('名称兼容停用只暂停当前命中的发布，精确发布操作不改变其他灰度版本', async t => {
    const f = await fixture(t), owner = await f.user(), other = await f.user();
    const first = await f.version(owner), firstRelease = await releases.publishSkillVersion(first.id, owner, { scope: 'personal' });
    const second = await f.version(owner, first.name, { version: '2.0.0' });
    const secondRelease = await releases.publishSkillVersion(second.id, owner, { scope: 'personal', targetUserIds: [other.id] });
    assert.equal(String((await releases.resolvePublishedSkill(first.name, owner)).id), String(firstRelease.id));
    assert.equal(String((await skills.disableAgentSkill(first.name, owner)).id), String(firstRelease.id));
    assert.equal((await queryOne('SELECT status FROM agent_skill_releases WHERE id=?', [secondRelease.id])).status, 'published');
    assert.equal(await releases.resolvePublishedSkill(first.name, owner), null);
    assert.equal(await skills.disableAgentSkill(first.name, other), null);
});

test('熔断键集分页覆盖首批之外的发布，首批状态变更不造成跳页', async t => {
    const f = await fixture(t), owner = await f.user(), version = await f.version(owner);
    const thresholds = { minSamples: 1, minFeedbackSamples: 1, negativeFeedbackRate: 0.1 };
    const oldest = await releases.publishSkillVersion(version.id, owner, { scope: 'personal', breakerThresholds: thresholds });
    await execute(`INSERT INTO agent_skill_releases(skill_version_id,owner_key,name,tenant_id,rollout_scope,status,published_by,breaker_thresholds)
        SELECT ?,?,?,1,'personal','published',?,?::jsonb FROM generate_series(1,201)`, [version.id, `user:${owner.id}`, version.name, owner.id, JSON.stringify(thresholds)]);
    const newest = await queryOne('SELECT id FROM agent_skill_releases WHERE skill_version_id=? ORDER BY id DESC LIMIT 1', [version.id]);
    for (const release of [oldest, newest]) {
        const runId = crypto.randomUUID();
        await execute("INSERT INTO agent_runs(id,user_id,title,goal,status,metadata) VALUES(?,?,'熔断回归','检查负反馈','completed',?::jsonb)", [runId, owner.id, JSON.stringify({ skillReleaseId: release.id })]);
        await execute("INSERT INTO agent_feedback(user_id,run_id,rating,outcome,source) VALUES(?,?,1,'failure','user')", [owner.id, runId]);
    }
    const result = await require('../server/services/agent-skill-breaker').sweepSkillReleaseBreakers();
    assert.ok(result.evaluated >= 202);
    for (const release of [oldest, newest]) {
        assert.equal(result.actions.filter(item => String(item.releaseId) === String(release.id)).length, 1);
        assert.equal((await queryOne('SELECT status FROM agent_skill_releases WHERE id=?', [release.id])).status, 'paused');
    }
});
