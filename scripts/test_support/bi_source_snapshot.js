'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function sourceSnapshot(root = path.resolve(__dirname, '../..')) {
    const files = ['package.json', 'package-lock.json', 'docs/design/Pivot_BI数据建模产品级建设方案-2026-11-06.md'];
    function walk(directory) {
        for (const item of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
            if (item.isSymbolicLink()) throw new Error('容量验证源码目录包含链接，请先核对固定构建。');
            const relative = `${directory}/${item.name}`;
            if (item.isDirectory()) walk(relative); else if (item.isFile()) files.push(relative);
        }
    }
    for (const directory of ['server', 'client', 'scripts', 'tests']) walk(directory);
    const hash = crypto.createHash('sha256'); let bytes = 0;
    for (const file of files.sort()) { const contents = fs.readFileSync(path.join(root, file)); bytes += contents.length; hash.update(file).update('\0').update(crypto.createHash('sha256').update(contents).digest()); }
    let commit = null;
    try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { /* 安装包没有 Git 元数据时仍保留完整文件指纹。 */ }
    return { commit, sha256: hash.digest('hex'), files: files.length, bytes };
}

module.exports = { sourceSnapshot };
