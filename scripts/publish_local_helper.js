'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeHelperManifest } = require('../server/services/client-downloads');

async function digest(file) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

async function publishLocalHelper({ root = path.resolve(__dirname, '..') } = {}) {
    const buildsRoot = await fs.realpath(path.join(root, 'dist-local-helper'));
    const build = JSON.parse(await fs.readFile(path.join(buildsRoot, 'latest-build.json'), 'utf8'));
    if (typeof build.unsigned !== 'boolean') throw new Error('助手构建记录缺少签名通道标识。');
    const filename = `PivotLocalHelper-${build.unsigned ? 'Dev-' : ''}Setup-${build.version}.exe`;
    if (!normalizeHelperManifest({ schemaVersion: 1, version: build.version, filename, channel: build.unsigned ? 'development' : 'release', size: 1, sha256: '0'.repeat(64) })) throw new Error('助手构建版本或文件名无效。');
    const sourceRoot = await fs.realpath(path.resolve(root, build.output));
    if (!sourceRoot.startsWith(buildsRoot + path.sep)) throw new Error('助手安装包必须来自独立助手构建目录。');
    const source = path.join(sourceRoot, filename);
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2) throw new Error('助手安装包不存在或类型无效。');
    const handle = await fs.open(source, 'r');
    try { const header = Buffer.alloc(2); await handle.read(header, 0, 2, 0); if (header.toString() !== 'MZ') throw new Error('助手安装包不是 Windows 可执行文件。'); } finally { await handle.close(); }
    const sha256 = await digest(source);
    const folder = path.join(root, 'downloads', 'local-helper');
    await fs.mkdir(folder, { recursive: true });
    const downloadsRoot = await fs.realpath(path.join(root, 'downloads'));
    if (path.dirname(await fs.realpath(folder)) !== downloadsRoot) throw new Error('助手发布目录超出下载目录。');
    const target = path.join(folder, filename);
    let exists = false;
    try {
        const current = await fs.lstat(target);
        if (!current.isFile() || current.isSymbolicLink() || await digest(target) !== sha256) throw new Error('同名助手安装包内容不同，请使用新的版本号发布。');
        exists = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!exists) await fs.copyFile(source, target, require('node:fs').constants.COPYFILE_EXCL);
    if (await digest(target) !== sha256) throw new Error('助手安装包复制后的校验值不一致。');
    const manifest = { schemaVersion: 1, version: build.version, filename, channel: build.unsigned ? 'development' : 'release', size: stat.size, sha256, publishedAt: new Date().toISOString() };
    const pending = path.join(folder, 'latest-' + crypto.randomUUID() + '.tmp');
    await fs.writeFile(pending, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    await fs.rename(pending, path.join(folder, 'latest.json'));
    return manifest;
}

if (require.main === module) publishLocalHelper().then(value => process.stdout.write(`助手已发布至 downloads/local-helper：${value.filename}（${value.channel === 'development' ? '开发验证版，未签名' : '正式构建'}）\n`)).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { publishLocalHelper };
