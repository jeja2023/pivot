'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const BACKUP_SOURCES = Object.freeze(['cas', 'uploads', 'document-processing', 'analysis', 'agent-blobs', 'agent-runtime-packs', 'agent-skills']);
const OPTIONAL_SOURCES = new Set(['document-processing', 'analysis', 'agent-blobs', 'agent-runtime-packs', 'agent-skills']);
const TEMPORARY_ROOTS = new Set(['document-processing', 'analysis']);

function backupPaths(env = process.env, root = path.resolve(__dirname, '../..')) {
    const data = path.resolve(env.DATA_DIR || path.join(root, 'data'));
    return {
        cas: path.resolve(env.PIVOT_ARTIFACT_CAS_DIR || path.join(data, 'agent-artifact-objects')),
        uploads: path.resolve(env.PIVOT_UPLOAD_DIR || env.UPLOAD_DIR || path.join(root, 'uploads')),
        'document-processing': path.resolve(env.PIVOT_DOCUMENT_PROCESSING_DIR || path.join(data, 'document-processing')),
        analysis: path.resolve(env.PIVOT_ANALYSIS_DIR || path.join(data, 'analysis')),
        'agent-blobs': path.resolve(env.AGENT_BLOB_DIR || path.join(data, 'agent-blobs')),
        'agent-runtime-packs': path.resolve(env.PIVOT_RUNTIME_PACK_ROOT || path.join(data, 'agent-runtime-packs')),
        'agent-skills': path.resolve(path.join(data, 'agent-skills'))
    };
}

async function digestFile(file) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of require('fs').createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

async function collectFiles(root, relative = '', { excludeTemporary = false } = {}) {
    const files = [];
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
        if (excludeTemporary && !relative && item.name.toLowerCase() === 'tmp') continue;
        const name = path.join(relative, item.name);
        if (item.isSymbolicLink()) throw new Error('备份目录含符号链接，请先确认实际存储位置。');
        if (item.isDirectory()) files.push(...await collectFiles(root, name, { excludeTemporary }));
        else if (item.isFile()) files.push(name);
        else throw new Error('备份目录含不支持的文件类型。');
    }
    return files;
}

async function verifyBackupBundle(root) {
    const actual = (await collectFiles(root)).map(name => name.split(path.sep).join('/'));
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
    if (![1, 2].includes(manifest.version) || !Array.isArray(manifest.files) || !manifest.files.length
        || !manifest.files.some(item => item.path === 'database.dump')) throw new Error('备份清单格式或数据库备份缺失。');
    const names = manifest.version === 1 ? ['cas', 'uploads'] : BACKUP_SOURCES;
    if (manifest.version === 2) {
        if (!manifest.sources || Object.keys(manifest.sources).length !== names.length || names.some(name => !['included', 'absent'].includes(manifest.sources[name]))) throw new Error('备份来源清单不完整。');
        for (const name of names) {
            if (!(await fs.lstat(path.join(root, name))).isDirectory()) throw new Error('备份来源目录缺失。');
            if (!OPTIONAL_SOURCES.has(name) && manifest.sources[name] !== 'included') throw new Error('必需备份来源缺失。');
        }
    }
    const expected = new Set(['manifest.json']);
    for (const item of manifest.files) {
        const parts = String(item.path || '').split('/');
        if (!(item.path === 'database.dump' || names.includes(parts[0]) && parts.length > 1 && !String(item.path).includes('\\'))
            || item.path.split('/').some(part => part === '..' || part === '.' || !part)
            || manifest.version === 2 && item.path !== 'database.dump' && (manifest.sources[parts[0]] !== 'included' || TEMPORARY_ROOTS.has(parts[0]) && parts[1].toLowerCase() === 'tmp')
            || expected.has(item.path)) throw new Error('备份清单含非法或重复路径。');
        expected.add(item.path);
        const file = path.join(root, item.path);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size !== item.bytes || await digestFile(file) !== item.sha256) throw new Error(`备份文件校验失败：${item.path}`);
    }
    if (actual.some(name => !expected.has(name))) throw new Error('备份目录包含未登记文件。');
    return manifest;
}

async function createBackupBundle({ output, maintenanceConfirmed, env = process.env, root, dumpDatabase }) {
    if (maintenanceConfirmed !== true) throw new Error('请先停止所有应用写入与后台任务，再显式确认维护窗口。');
    const sources = backupPaths(env, root);
    const requested = path.resolve(output);
    const target = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
    const sourceStates = {};
    const resolvedSources = [];
    for (const [name, source] of Object.entries(sources)) {
        let realSource;
        try { realSource = await fs.realpath(source); }
        catch (error) {
            const explicitlyConfigured = (name === 'document-processing' && env.PIVOT_DOCUMENT_PROCESSING_DIR) || (name === 'analysis' && env.PIVOT_ANALYSIS_DIR)
                || (name === 'agent-blobs' && env.AGENT_BLOB_DIR) || (name === 'agent-runtime-packs' && env.PIVOT_RUNTIME_PACK_ROOT);
            if (error.code !== 'ENOENT' || !OPTIONAL_SOURCES.has(name) || explicitlyConfigured) throw error;
            sourceStates[name] = 'absent';
            continue;
        }
        const relative = path.relative(realSource, target);
        if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('备份输出目录不得位于被备份目录内。');
        for (const other of resolvedSources) {
            const forward = path.relative(other, realSource), backward = path.relative(realSource, other);
            if (!forward || !backward || (!forward.startsWith('..') && !path.isAbsolute(forward)) || (!backward.startsWith('..') && !path.isAbsolute(backward))) throw new Error('备份来源目录不得相互包含。');
        }
        resolvedSources.push(realSource);
        sourceStates[name] = 'included';
        await collectFiles(source, '', { excludeTemporary: TEMPORARY_ROOTS.has(name) });
    }
    // 不覆盖旧备份；失败留下 incomplete 标记，禁止把半包当成成功恢复点。
    await fs.mkdir(target, { mode: 0o700 });
    await fs.writeFile(path.join(target, 'incomplete'), '备份尚未完成。', { mode: 0o600 });
    const files = [];
    await dumpDatabase(path.join(target, 'database.dump'));
    for (const [name, source] of Object.entries(sources)) {
        await fs.mkdir(path.join(target, name));
        if (sourceStates[name] === 'absent') continue;
        for (const relative of await collectFiles(source, '', { excludeTemporary: TEMPORARY_ROOTS.has(name) })) {
            const destination = path.join(target, name, relative);
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.copyFile(path.join(source, relative), destination, require('fs').constants.COPYFILE_EXCL);
        }
    }
    for (const relative of await collectFiles(target)) {
        if (relative === 'incomplete') continue;
        const file = path.join(target, relative);
        files.push({ path: relative.split(path.sep).join('/'), bytes: (await fs.stat(file)).size, sha256: await digestFile(file) });
    }
    const manifest = { version: 2, createdAt: new Date().toISOString(), maintenanceConfirmed: true, sources: sourceStates, files };
    await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await fs.unlink(path.join(target, 'incomplete'));
    await verifyBackupBundle(target);
    return manifest;
}

module.exports = { BACKUP_SOURCES, backupPaths, collectFiles, createBackupBundle, verifyBackupBundle, digestFile };
