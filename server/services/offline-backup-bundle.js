'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

function backupPaths(env = process.env, root = path.resolve(__dirname, '../..')) {
    const data = path.resolve(env.DATA_DIR || path.join(root, 'data'));
    return {
        cas: path.resolve(env.PIVOT_ARTIFACT_CAS_DIR || path.join(data, 'agent-artifact-objects')),
        uploads: path.resolve(env.PIVOT_UPLOAD_DIR || env.UPLOAD_DIR || path.join(root, 'uploads'))
    };
}

async function digestFile(file) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of require('fs').createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

async function collectFiles(root, relative = '') {
    const files = [];
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
        const name = path.join(relative, item.name);
        if (item.isSymbolicLink()) throw new Error('备份目录含符号链接，请先确认实际存储位置。');
        if (item.isDirectory()) files.push(...await collectFiles(root, name));
        else if (item.isFile()) files.push(name);
        else throw new Error('备份目录含不支持的文件类型。');
    }
    return files;
}

async function verifyBackupBundle(root) {
    const actual = (await collectFiles(root)).map(name => name.split(path.sep).join('/'));
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
    if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length
        || !manifest.files.some(item => item.path === 'database.dump')) throw new Error('备份清单格式或数据库备份缺失。');
    const expected = new Set(['manifest.json']);
    for (const item of manifest.files) {
        if (!/^(database\.dump|(?:cas|uploads)\/[^\\]+)$/.test(item.path)
            || item.path.split('/').some(part => part === '..' || part === '.' || !part)
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
    for (const source of Object.values(sources)) {
        const realSource = await fs.realpath(source);
        const relative = path.relative(realSource, target);
        if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('备份输出目录不得位于被备份目录内。');
        await collectFiles(source);
    }
    // 不覆盖旧备份；失败留下 incomplete 标记，禁止把半包当成成功恢复点。
    await fs.mkdir(target, { mode: 0o700 });
    await fs.writeFile(path.join(target, 'incomplete'), '备份尚未完成。', { mode: 0o600 });
    const files = [];
    await dumpDatabase(path.join(target, 'database.dump'));
    for (const [name, source] of Object.entries(sources)) {
        await fs.mkdir(path.join(target, name));
        for (const relative of await collectFiles(source)) {
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
    const manifest = { version: 1, createdAt: new Date().toISOString(), maintenanceConfirmed: true, files };
    await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await fs.unlink(path.join(target, 'incomplete'));
    await verifyBackupBundle(target);
    return manifest;
}

module.exports = { backupPaths, collectFiles, createBackupBundle, verifyBackupBundle, digestFile };
