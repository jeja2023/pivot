'use strict';
const { TextDecoder } = require('node:util');
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { normalizeRelativeEntryPath } = require('./agent-path-safety');
const { packageDigest, MAX_PACKAGE_FILES, MAX_UNPACKED_BYTES } = require('./agent-skill-packages');
const { scanSkillPackageEntries } = require('./agent-skill-supply-chain');
const { parseJsonObject } = require('./agent-validators');
function error(message, status = 409) {
    return Object.assign(new Error(message), { code: 'SKILL_RESOURCE_UNAVAILABLE', status, category: 'policy' });
}
const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
async function readInstalledSkillResourcesChecked(directory, options = {}) {
    const root = path.resolve(options.root || process.env.AGENT_SKILL_ROOT || path.join(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'agent-skills'));
    const resolved = path.resolve(directory), digest = path.basename(resolved);
    if (!/^[a-f0-9]{64}$/.test(digest) || !same(path.dirname(resolved), path.join(root, 'sha256')))
        throw error('技能资源不在已登记的内容目录中。');
    const entries = [], names = new Set();
    let bytes = 0;
    async function scanSkillResourceDirectory(folder, prefix = '', depth = 0) {
        options.signal?.throwIfAborted();
        if (depth > 12)
            throw error('技能资源目录层级超过限制。');
        const stat = await fs.lstat(folder);
        if (!stat.isDirectory() || stat.isSymbolicLink() || !same(await fs.realpath(folder), folder))
            throw error('技能资源目录已变化或经过链接。');
        for (const item of await fs.readdir(folder, { withFileTypes: true })) {
            const name = normalizeRelativeEntryPath(prefix + item.name), target = path.join(folder, item.name);
            if (item.isSymbolicLink())
                throw error('技能资源禁止链接。');
            if (item.isDirectory()) {
                await scanSkillResourceDirectory(target, name + '/', depth + 1);
                continue;
            }
            if (!item.isFile() || entries.length >= MAX_PACKAGE_FILES || names.has(name.toLowerCase()))
                throw error('技能资源类型、数量或路径无效。');
            names.add(name.toLowerCase());
            const stat = await fs.lstat(target);
            if (stat.isSymbolicLink() || !stat.isFile() || !same(await fs.realpath(target), target))
                throw error('技能资源路径已变化。');
            if (bytes + stat.size > MAX_UNPACKED_BYTES)
                throw error('技能资源超过大小限制。');
            const handle = await fs.open(target, 'r');
            let data;
            try {
                const opened = await handle.stat();
                if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size)
                    throw error('技能资源读取期间发生变化。');
                data = await handle.readFile();
                const after = await handle.stat();
                if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
                    throw error('技能资源读取期间发生变化。');
            }
            finally {
                await handle.close();
            }
            options.signal?.throwIfAborted();
            bytes += data.length;
            if (bytes > MAX_UNPACKED_BYTES)
                throw error('技能资源超过大小限制。');
            entries.push({ name, data });
        }
    }
    await scanSkillResourceDirectory(resolved);
    if (packageDigest(entries) !== digest)
        throw error('技能包内容摘要不匹配，请重新导入可信版本。');
    const manifestEntry = entries.find(item => ['SKILL.md', 'SKILL.json', 'SKILL.yaml', 'SKILL.yml'].includes(item.name));
    if (!manifestEntry)
        throw error('技能包缺少清单。');
    const manifest = manifestEntry.name === 'SKILL.md' ? require('./agent-skill-source').parseSkillSourceMarkdown(manifestEntry.data.toString('utf8')).manifest : require('./agent-skills').parseSkillManifest(manifestEntry.data.toString('utf8'));
    const checked = scanSkillPackageEntries(entries, manifest);
    if (!checked.passed)
        throw error('技能资源未通过包内容校验。');
    return { entries, digest };
}
async function readInstalledSkillResources(directory, options = {}) {
    try {
        return await readInstalledSkillResourcesChecked(directory, options);
    }
    catch (cause) {
        options.signal?.throwIfAborted();
        if (cause.code === 'SKILL_RESOURCE_UNAVAILABLE')
            throw cause;
        throw error('技能包文件不可访问或格式无效，请重新导入可信版本。');
    }
}
async function authorizedPackage(user, context = {}, deps = {}) {
    const metadata = parseJsonObject(context.run?.metadata) || {};
    if (!metadata.skillName || !metadata.skillVersionId || !metadata.skillReleaseId)
        throw error('请先为任务选择已发布技能。', 400);
    const release = await (deps.resolve || require('./agent-releases').resolvePublishedSkill)(metadata.skillName, user);
    if (!release || String(release.id) !== String(metadata.skillReleaseId) || String(release.skill_version_id) !== String(metadata.skillVersionId))
        throw error('技能发布已变化或授权已撤回，请重新选择技能。', 403);
    if (!await (deps.sourceActive || require('../repositories/agent-learning-evaluation').sourceIsActive)(release.skill_version_id))
        throw error('技能来源已撤回。', 403);
    const version = await (deps.version || require('../repositories/agent-skill-resources').readVersion)(release.skill_version_id);
    if (!version?.package_path)
        return { entries: [], digest: null, reference: { releaseId: release.id, versionId: release.skill_version_id } };
    let signature = null;
    if (version.signing_envelope_id) {
        signature = await (deps.verify || require('./agent-skill-signing').verifyEnvelopeForVersion)(version);
        if (!signature.verified)
            throw error('技能签名已失效或撤回。', 403);
    }
    const pack = await (deps.read || readInstalledSkillResources)(version.package_path, { signal: context.signal });
    // 有包签名时，数据库里的不可变版本摘要也必须与实际目录一致。
    if (signature?.signatureForm === 'detached' && String(version.digest).replace(/^sha256:/, '') !== pack.digest)
        throw error('技能包签名摘要与资源不一致。');
    const current = await (deps.resolve || require('./agent-releases').resolvePublishedSkill)(metadata.skillName, user);
    if (!current || String(current.id) !== String(release.id) || String(current.skill_version_id) !== String(release.skill_version_id))
        throw error('读取期间技能授权或版本已变化。', 403);
    return { ...pack, reference: { releaseId: release.id, versionId: release.skill_version_id } };
}
const metadataFiles = new Set(['SKILL.md', 'SKILL.json', 'SKILL.yaml', 'SKILL.yml', 'SKILL.sig', 'package.sig', 'INSTRUCTIONS.md', 'instructions.md']);
function definitions() {
    return [
        { name: 'skill.resources', title: '查看当前技能资源', description: '列出当前任务已选技能包中的参考资料、模板和图片；逐次检查发布授权与内容摘要。', source: 'builtin', risk_level: 1, idempotent: true, side_effect: false, concurrency: 'read', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
        { name: 'skill.read_resource', title: '读取当前技能资源', description: '按资源清单的相对路径读取文本或图片。文本按字符分页，模板等二进制文件只返回摘要；不执行脚本，不读取技能包外文件。', source: 'builtin', risk_level: 1, idempotent: true, side_effect: false, concurrency: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 16000 } }, required: ['path'], additionalProperties: false } }
    ];
}
async function execute(name, input, user, context, deps = {}) {
    const pack = await authorizedPackage(user, context, deps), entries = pack.entries.filter(item => !metadataFiles.has(item.name));
    if (name === 'skill.resources')
        return { reference: pack.reference, packageDigest: pack.digest, resources: entries.map(item => ({ path: item.name, bytes: item.data.length, digest: crypto.createHash('sha256').update(item.data).digest('hex') })) };
    const resourcePath = normalizeRelativeEntryPath(input.path), item = entries.find(entry => entry.name === resourcePath);
    if (!item)
        throw error('技能资源不存在，请先读取资源清单。', 404);
    const offset = input.offset === undefined ? 0 : Number(input.offset), limit = input.limit === undefined ? 8000 : Number(input.limit);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000)
        throw error('资源读取范围无效。', 400);
    const result = { reference: pack.reference, packageDigest: pack.digest, path: item.name, bytes: item.data.length, digest: crypto.createHash('sha256').update(item.data).digest('hex') };
    if (/\.(png|jpe?g|webp)$/i.test(item.name) && item.data.length <= 2 * 1024 * 1024)
        return { ...result, content: [{ type: 'image', mimeType: 'image/' + (path.extname(item.name).slice(1).replace('jpg', 'jpeg')), data: item.data.toString('base64') }] };
    if (!/\.(md|txt|csv|tsv|json|ya?ml|xml|html|css|svg)$/i.test(item.name))
        return { ...result, readable: false, message: '该二进制资源不直接进入模型上下文，请使用对应文件工具处理。' };
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(item.data);
    }
    catch (_) {
        throw error('文本资源不是有效 UTF-8，请转换后重新导入。');
    }
    if (offset > text.length)
        throw error('资源起始位置超出文本范围。', 400);
    return { ...result, text: text.slice(offset, offset + limit), offset, totalCharacters: text.length, nextOffset: offset + limit < text.length ? offset + limit : null };
}
async function assertSkillResourceEvidence(run, user, deps = {}) {
    const metadata = parseJsonObject(run?.metadata) || {}, evidence = metadata.skillResourceEvidence;
    if (!evidence)
        return;
    const current = await authorizedPackage(user, { run }, deps);
    if (String(current.reference.releaseId) !== String(evidence.releaseId) || String(current.reference.versionId) !== String(evidence.versionId) || current.digest !== evidence.packageDigest)
        throw error('任务使用的技能配套资料已失效，请重新选择技能后运行。', 403);
}
module.exports = { readInstalledSkillResources, definitions, execute, assertSkillResourceEvidence };
