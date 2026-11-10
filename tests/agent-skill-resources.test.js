'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { packageDigest } = require('../server/services/agent-skill-packages');
const resources = require('../server/services/agent-skill-resources');
const { prepareToolVision } = require('../server/services/agent-tool-vision');
async function fixture(fn) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-skill-resources-'));
    const entries = [{ name: 'SKILL.json', data: Buffer.from(JSON.stringify({ id: 'resource-test', name: 'resource-test', version: '1.0.0', files: ['references/rules.md', 'assets/image.png'] })) },
        { name: 'references/rules.md', data: Buffer.from('第一段；第二段；末尾依据') }, { name: 'assets/image.png', data: await require('sharp')({ create: { width: 3, height: 3, channels: 3, background: '#fff' } }).png().toBuffer() }];
    const digest = packageDigest(entries), directory = path.join(root, 'sha256', digest);
    for (const item of entries) {
        await fs.mkdir(path.dirname(path.join(directory, item.name)), { recursive: true });
        await fs.writeFile(path.join(directory, item.name), item.data);
    }
    const release = { id: 3, skill_version_id: 4 }, context = { run: { metadata: { skillName: 'resource-test', skillReleaseId: 3, skillVersionId: 4 } } }, user = { id: 7 };
    const deps = { resolve: async () => release, sourceActive: async () => true, version: async () => ({ package_path: directory, digest: 'sha256:' + digest }), read: dir => resources.readInstalledSkillResources(dir, { root }) };
    try {
        await fn({ root, directory, entries, release, context, user, deps });
    }
    finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}
test('当前技能资源按目录和摘要读取，文本分页与图片使用同一真实工具输出', () => fixture(async ({ context, user, deps }) => {
    const catalog = await resources.execute('skill.resources', {}, user, context, deps);
    assert.equal(catalog.resources.length, 2);
    assert(catalog.resources.every(item => item.digest.length === 64));
    const first = await resources.execute('skill.read_resource', { path: 'references/rules.md', limit: 4 }, user, context, deps);
    assert.equal(first.text, '第一段；');
    assert.equal(first.nextOffset, 4);
    const tail = await resources.execute('skill.read_resource', { path: 'references/rules.md', offset: 4, limit: 16000 }, user, context, deps);
    assert.equal(first.text + tail.text, '第一段；第二段；末尾依据');
    assert.equal(tail.nextOffset, null);
    const image = await resources.execute('skill.read_resource', { path: 'assets/image.png' }, user, context, deps);
    let saved = false;
    const projected = await prepareToolVision(image, user, { tenant: async () => ({ tenantId: 1 }), put: async () => {
            saved = true;
            return { ref: 'artifact-cas://' + 'a'.repeat(64) };
        } });
    assert(saved);
    assert.equal(projected.toolVision.refs.length, 1);
    await assert.rejects(() => resources.execute('skill.read_resource', { path: '../outside' }, user, context, deps));
    await assert.rejects(() => resources.execute('skill.read_resource', { path: 'references/rules.md', offset: 10000 }, user, context, deps), /超出/);
}));
test('发布撤销、版本变化与读取中撤权均拒绝，不把缓存当作权限', () => fixture(async ({ context, user, deps }) => {
    await assert.rejects(() => resources.execute('skill.resources', {}, user, {}, deps), /选择/);
    await assert.rejects(() => resources.execute('skill.resources', {}, user, context, { ...deps, resolve: async () => null }), /撤回/);
    await assert.rejects(() => resources.execute('skill.resources', {}, user, context, { ...deps, sourceActive: async () => false }), /撤回/);
    let reads = 0;
    await assert.rejects(() => resources.execute('skill.resources', {}, user, context, { ...deps, resolve: async () => ++reads === 1 ? { id: 3, skill_version_id: 4 } : { id: 8, skill_version_id: 4 } }), /读取期间/);
}));
test('包文件篡改、额外文件和目录链接均拒绝，不能凭内容地址目录名声称完整', () => fixture(async ({ root, directory, entries }) => {
    const target = path.join(directory, 'references/rules.md');
    await fs.writeFile(target, '被替换');
    await assert.rejects(() => resources.readInstalledSkillResources(directory, { root }), /摘要/);
    await fs.writeFile(target, entries[1].data);
    await fs.writeFile(path.join(directory, 'extra.txt'), '额外文件');
    await assert.rejects(() => resources.readInstalledSkillResources(directory, { root }), /摘要/);
    await fs.unlink(path.join(directory, 'extra.txt'));
    const references = path.join(directory, 'references'), outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'rules.md'), entries[1].data);
    await fs.rm(references, { recursive: true });
    await fs.symlink(outside, references, 'junction');
    await assert.rejects(() => resources.readInstalledSkillResources(directory, { root }), /链接/);
}));
test('工具读取后的来源证据在下一次模型调用前复查，版本和内容摘要均绑定', () => fixture(async ({ context, user, deps }) => {
    const listing = await resources.execute('skill.resources', {}, user, context, deps);
    const run = { ...context.run, metadata: { ...context.run.metadata, skillResourceEvidence: { ...listing.reference, packageDigest: listing.packageDigest } } };
    await resources.assertSkillResourceEvidence(run, user, deps);
    await assert.rejects(() => resources.assertSkillResourceEvidence(run, user, { ...deps, resolve: async () => null }), /撤回/);
    await assert.rejects(() => resources.assertSkillResourceEvidence({ ...run, metadata: { ...run.metadata, skillResourceEvidence: { ...run.metadata.skillResourceEvidence, packageDigest: 'x' } } }, user, deps), /已失效/);
}));
