'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const sealed = require('./backup-sealed-files');
const { backupPaths } = require('./offline-backup-bundle');

function safeRelative(relative) {
    return typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') && !path.posix.isAbsolute(relative)
        && relative.split('/').every(part => part && !['.', '..'].includes(part));
}
async function applicationRoots(env = process.env, projectRoot = path.resolve(__dirname, '../..'), { allowMissing = false } = {}) {
    const candidates = { data: path.resolve(env.DATA_DIR || path.join(projectRoot, 'data')), ...backupPaths(env, projectRoot) };
    const directories = [], aliases = {};
    for (const [name, directory] of Object.entries(candidates)) {
        let stat;
        try { stat = await fs.lstat(directory); }
        catch (error) { if (error.code === 'ENOENT') { aliases[name] = { path: directory, absent: true }; continue; } throw error; }
        if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) throw new Error('共享恢复目录不得包含符号链接或别名。');
        aliases[name] = { path: directory, absent: false }; directories.push(directory);
    }
    if (!allowMissing && (aliases.data.absent || aliases.uploads.absent)) throw new Error('共享恢复单位缺少 data 或 uploads。');
    const roots = [...new Set(directories)].sort().filter(directory => !directories.some(other => other !== directory && sealed.inside(other, directory)));
    const exclusions = [path.join(aliases.analysis.path, 'tmp'), path.join(aliases.analysis.path, 'objects', '.tmp-write'),
        path.join(aliases.cas.path, '.tmp-write'), path.join(aliases['document-processing'].path, 'tmp')];
    return { roots, aliases, exclusions, projectRoot };
}
async function scanRecoveryFiles(roots, deadline = Infinity, exclusions = []) {
    const files = [];
    const excluded = new Set(exclusions.map(directory => path.resolve(directory)));
    async function walkRecoveryDirectory(root, directory, relative = '') {
        if (Date.now() >= deadline) throw new Error('共同恢复点文件清单超过五秒屏障时限。');
        for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const name = relative ? `${relative}/${entry.name}` : entry.name;
            if (!safeRelative(name)) throw new Error('共享文件名不符合跨平台恢复边界。');
            const file = path.join(directory, entry.name), stat = await fs.lstat(file, { bigint: true });
            if (stat.isSymbolicLink()) throw new Error('共享恢复目录包含符号链接。');
            if (excluded.has(file)) {
                if (!stat.isDirectory()) throw new Error('已声明的临时目录不是常规目录。');
                continue;
            }
            if (stat.isDirectory()) await walkRecoveryDirectory(root, file, name);
            else if (stat.isFile()) files.push({ root, path: name, bytes: String(stat.size), signature: sealed.signature(stat) });
            else throw new Error('共享恢复目录包含不支持的文件类型。');
            if (Date.now() >= deadline) throw new Error('共同恢复点文件清单超过五秒屏障时限。');
        }
    }
    for (const root of roots) await walkRecoveryDirectory(root, root);
    return files;
}
async function collectDirectories(root, relative = '') {
    const result = [];
    for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (!safeRelative(name) || entry.isSymbolicLink()) throw new Error('物理目录清单含不安全路径或链接。');
        if (entry.isDirectory()) { result.push(name); result.push(...await collectDirectories(root, name)); }
    }
    return result;
}
function sameSignatures(left, right) {
    return left.length === right.length && left.every((file, index) => file.root === right[index].root && file.path === right[index].path && file.signature === right[index].signature);
}
async function boundedFiles(items, operation) {
    const results = new Array(items.length); let cursor = 0, failure;
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
        while (!failure && cursor < items.length) {
            const index = cursor++;
            try { results[index] = await operation(items[index]); }
            catch (error) { failure ||= error; }
        }
    }));
    // 在返回错误前排空所有进行中的文件操作；调用方失败时可能立即清理其专有暂存目录。

    if (failure) throw failure;
    return results;
}
async function precopy({ roots, backupRoot, key, clusterId, exclusions = [] }) {
    const before = await scanRecoveryFiles(roots, Infinity, exclusions);
    const files = await boundedFiles(before, async item => {
        const source = path.join(item.root, item.path), digest = await sealed.digest(source);
        const record = await sealed.sealFile({ source, destination: objectPath(backupRoot, digest), key, context: objectContext(clusterId, digest), expectedDigest: digest });
        if (item.signature !== sealed.signature(await sealed.regularFile(source))) throw new Error('预复制期间共享文件已变化，请重新建立恢复点。');
        return { ...item, sha256: record.sha256 };
    });
    if (!sameSignatures(before, await scanRecoveryFiles(roots, Infinity, exclusions))) throw new Error('预复制期间共享清单已变化，请重新建立恢复点。');
    return files;
}
function objectPath(root, digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('备份对象摘要无效。');
    return path.join(root, 'objects', `${digest}.seal`);
}
function objectContext(clusterId, digest) { return `object:${clusterId}:${digest}`; }
async function verifyObjects({ files, backupRoot, key, clusterId }) {
    const seen = new Set();
    for (const item of files) {
        if (!safeRelative(item.path) || !Number.isSafeInteger(Number(item.bytes)) || Number(item.bytes) < 0 || !path.isAbsolute(item.root)) throw new Error('恢复对象清单无效。');
        const identity = `${item.root}:${item.path}`;
        if (seen.has(identity)) throw new Error('恢复对象清单包含重复路径。');
        seen.add(identity);
    }
    await boundedFiles(files, item => sealed.verifyFile({ source: objectPath(backupRoot, item.sha256), key, context: objectContext(clusterId, item.sha256), expectedDigest: item.sha256, expectedBytes: item.bytes }));
}
async function restoreObjects({ files, roots, backupRoot, key, clusterId }) {
    await verifyObjects({ files, backupRoot, key, clusterId });
    for (const root of roots) {
        // 仅恢复到显式为空的真实逻辑挂载点；在无关应用中重定位存储路径不属于物理恢复。

        await sealed.privateDirectory(root);
        if ((await fs.readdir(root)).length) throw new Error('共享文件恢复目标必须为空，禁止覆盖现有业务目录。');
    }
    await boundedFiles(files, async item => {
        if (!roots.includes(item.root)) throw new Error('恢复清单包含恢复单位之外的路径。');
        const destination = path.join(item.root, ...item.path.split('/'));
        if (!sealed.inside(item.root, destination)) throw new Error('恢复文件越过受控逻辑目录。');
        await sealed.restoreFile({ source: objectPath(backupRoot, item.sha256), destination, key, context: objectContext(clusterId, item.sha256), expectedDigest: item.sha256, expectedBytes: item.bytes });
    });
}

function resolveReference(application, item) {
    const aliases = application.aliases;
    if (item.kind === 'analysis_object' || item.kind === 'cas') {
        if (!safeRelative(item.path)) throw new Error('数据库对象引用包含不安全路径。');
        return path.join(item.kind === 'cas' ? aliases.cas.path : path.join(aliases.analysis.path, 'objects'), ...item.path.split('/'));
    }
    const value = String(item.path || '').replace(/\\/g, '/');
    if (!value) throw new Error('数据库存在就绪资源但缺少文件引用。');
    if (path.isAbsolute(value)) return path.resolve(value);
    for (const [prefix, root] of [['@analysis/', aliases.analysis.path], ['document-processing/', aliases['document-processing'].path], ['uploads/', aliases.uploads.path], ['data/', aliases.data.path]]) {
        if (value.startsWith(prefix)) {
            const relative = value.slice(prefix.length);
            if (!safeRelative(relative)) throw new Error('数据库文件引用包含不安全路径。');
            return path.join(root, ...relative.split('/'));
        }
    }
    if (!safeRelative(value)) throw new Error('数据库文件引用包含不安全路径。');
    return path.resolve(application.projectRoot, value);
}
function verifyReferences(application, inventory, files) {
    if (inventory.length > 1000000) throw new Error('共同恢复点引用超过单次核对边界。');
    const byPath = new Map(files.map(item => [path.resolve(item.root, item.path), item]));
    for (const item of inventory) {
        const file = byPath.get(resolveReference(application, item));
        if (!file) throw new Error(`共同恢复点缺少数据库必须文件：${item.kind}:${item.id}`);
        if (item.sha256 && /^[a-f0-9]{64}$/i.test(item.sha256.trim()) && item.sha256.trim().toLowerCase() !== file.sha256) throw new Error(`共同恢复点文件不符合数据库摘要：${item.kind}:${item.id}`);
        // 部分旧版源元数据对未知字节大小使用零表示。
        if (item.bytes && Number(item.bytes) > 0 && item.bytes !== file.bytes) throw new Error(`共同恢复点文件不符合数据库长度：${item.kind}:${item.id}`);
    }
}

module.exports = { safeRelative, applicationRoots, scan: scanRecoveryFiles, collectDirectories, sameSignatures, precopy, objectPath, objectContext, verifyObjects, restoreObjects, verifyReferences };
