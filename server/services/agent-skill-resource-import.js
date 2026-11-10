'use strict';
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { normalizeRelativeEntryPath } = require('./agent-path-safety');
const { canonicalJson } = require('./canonical-json');
const MAX_FILES = 32, MAX_BYTES = 4 * 1024 * 1024, MAX_FILE_BYTES = 2 * 1024 * 1024;
function invalid(message) {
    return Object.assign(new Error(message), { code: 'SKILL_RESOURCE_IMPORT_INVALID', status: 422, expose: true });
}
function normalizeResourceInputs(values = []) {
    if (!Array.isArray(values) || values.length > MAX_FILES)
        throw invalid('技能配套文件最多32个。');
    const paths = new Set();
    let bytes = 0;
    return values.map(item => {
        if (!item || typeof item !== 'object' || typeof item.path !== 'string')
            throw invalid('配套文件格式无效。');
        const name = normalizeRelativeEntryPath(item.path);
        if (name.length > 240 || !name.includes('/') || paths.has(name.toLowerCase()) || !/^(references|assets|templates)\//.test(name))
            throw invalid('配套文件必须位于 references、assets 或 templates 目录，路径不能重复。');
        paths.add(name.toLowerCase());
        if (!/\.(md|txt|csv|tsv|json|ya?ml|xml|html|css|svg|png|jpe?g|webp)$/i.test(name))
            throw invalid('当前支持文本参考资料和图片；脚本及其他二进制模板需另行适配。');
        if (typeof item.content !== 'string' || item.content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4)
            throw invalid('单个配套文件超过2 MiB或内容无效。');
        if (!['utf8', 'base64'].includes(item.encoding || 'utf8'))
            throw invalid('配套文件编码无效。');
        if (item.encoding === 'base64' && !/^[A-Za-z0-9+/]*={0,2}$/.test(item.content))
            throw invalid('配套文件编码无效。');
        const data = Buffer.from(item.content, item.encoding === 'base64' ? 'base64' : 'utf8');
        bytes += data.length;
        if (data.length > MAX_FILE_BYTES || bytes > MAX_BYTES)
            throw invalid('配套文件总量最多4 MiB，单文件最多2 MiB。');
        if (!/\.(png|jpe?g|webp)$/i.test(name)) {
            try {
                new TextDecoder('utf-8', { fatal: true }).decode(data);
            }
            catch (_) {
                throw invalid('文本配套文件必须使用UTF-8编码。');
            }
        }
        const digest = crypto.createHash('sha256').update(data).digest('hex');
        return { name, data, digest, bytes: data.length };
    }).sort((a, b) => a.name.localeCompare(b.name));
}
function resourceManifestEntries(entries) {
    return entries.map(item => ({ path: item.name, digest: item.digest, bytes: item.bytes }));
}
function validateResourceManifest(manifest) {
    if (manifest.resources === undefined)
        return [];
    if (!Array.isArray(manifest.resources) || manifest.resources.length > MAX_FILES)
        return ['技能资源清单格式无效。'];
    const paths = new Set(), errors = [];
    for (const item of manifest.resources) {
        try {
            const name = normalizeRelativeEntryPath(item.path);
            if (paths.has(name.toLowerCase()) || !Array.isArray(manifest.files) || !manifest.files.includes(name) || !/^[a-f0-9]{64}$/.test(item.digest) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > MAX_FILE_BYTES)
                throw invalid('资源摘要或文件清单不一致');
            paths.add(name.toLowerCase());
        }
        catch (_) {
            errors.push('技能资源路径、摘要、大小或文件清单无效。');
        }
    }
    return errors;
}
async function installImportedResources(markdown, manifest, values) {
    const entries = normalizeResourceInputs(values);
    if (!entries.length && !manifest.resources?.length)
        return null;
    if (canonicalJson(manifest.resources || []) !== canonicalJson(resourceManifestEntries(entries)))
        throw invalid('配套文件与预览时的资源摘要不一致，请重新预览。');
    for (const entry of entries) {
        if (/\.(png|jpe?g|webp)$/i.test(entry.name)) {
            try {
                const decoder = require('sharp')(entry.data, { limitInputPixels: 16000000 });
                const info = await decoder.metadata();
                const expected = entry.name.split('.').at(-1).toLowerCase().replace('jpg', 'jpeg');
                if (info.format !== expected || (info.pages || 1) > 1)
                    throw invalid('图片格式不一致或包含多帧');
                await decoder.stats();
            }
            catch (_) {
                throw invalid('配套图片无效、格式不一致或超过像素范围，请使用静态PNG、JPEG或WebP图片。');
            }
        }
    }
    const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), JSZip = require('jszip');
    const zip = new JSZip();
    zip.file('SKILL.md', markdown);
    for (const entry of entries)
        zip.file(entry.name, entry.data);
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-skill-import-'));
    try {
        const file = path.join(temp, 'resources.skill.zip');
        await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
        return await require('./agent-skill-packages').installSkillPackage(file, { requireSignature: false, installRoot: process.env.AGENT_SKILL_ROOT });
    }
    finally {
        await fs.rm(temp, { recursive: true, force: true });
    }
}
function declarativeResourcePackage(manifest) {
    if (!manifest.resources?.length || validateResourceManifest(manifest).length || !Array.isArray(manifest.files) || manifest.files.length !== manifest.resources.length || Object.keys(manifest.dependencies || {}).length)
        return false;
    return manifest.resources.every(item => /^(references|assets|templates)\//.test(item.path) && /\.(md|txt|csv|tsv|json|ya?ml|xml|html|css|svg|png|jpe?g|webp)$/i.test(item.path));
}
// 资源配方只含摘要绑定的静态资料；传统完整包和显式共享验证仍要求签名。
async function requiresPackageSignature(version,manifest,options={}) {
    const recipe=declarativeResourcePackage(manifest);
    if(recipe&&version.package_path)await require('./agent-skill-resources').readInstalledSkillResources(version.package_path);
    return options.requireSignature===true||Boolean(String(version.package_path||'').trim())&&!recipe;
}
module.exports = { normalizeResourceInputs, resourceManifestEntries, validateResourceManifest, installImportedResources, declarativeResourcePackage, requiresPackageSignature };
