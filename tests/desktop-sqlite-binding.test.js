'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const afterPack = require('../scripts/after-pack');
const { readDesktopSqliteBinding } = require('../scripts/desktop_sqlite_binding');

test('桌面绑定替换仅写入制品目录，拒绝平台、版本或摘要不一致的构建输入', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-sqlite-package-'));
    const original = process.env.PIVOT_DESKTOP_SQLITE_MANIFEST;
    const binding = path.join(root, 'isolated.node'), manifestPath = path.join(root, 'binding.json');
    const workspaceBinding = path.join(root, 'workspace.node');
    const target = path.join(root, 'output', 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3');
    fs.writeFileSync(binding, 'electron-abi-target');fs.writeFileSync(workspaceBinding, 'host-node-abi');
    const manifest = { version: 1, platform: 'win32', arch: 'x64', packageVersion: '12.11.1', electronVersion: '43.8.7', abi: '148', binding, sha256: crypto.createHash('sha256').update(fs.readFileSync(binding)).digest('hex') };
    const write = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const context = { appOutDir: path.join(root, 'output'), electronPlatformName: 'win32', arch: 1 };
    try {
        write();
        assert.throws(() => readDesktopSqliteBinding(manifestPath, 'linux', 'x64'), /目标不符/);
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ version: '12.10.0' }));
        process.env.PIVOT_DESKTOP_SQLITE_MANIFEST = manifestPath;
        await assert.rejects(afterPack(context), /依赖不符/);
        fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ version: '12.11.1' }));
        await afterPack(context);
        assert.equal(fs.readFileSync(path.join(target, 'build', 'Release', 'better_sqlite3.node'), 'utf8'), 'electron-abi-target');
        assert.equal(fs.readFileSync(workspaceBinding, 'utf8'), 'host-node-abi');
        fs.appendFileSync(binding, 'tampered');
        await assert.rejects(afterPack(context), /摘要不符/);
        assert.equal(fs.readFileSync(path.join(target, 'build', 'Release', 'better_sqlite3.node'), 'utf8'), 'electron-abi-target');
    } finally {
        if (original === undefined) delete process.env.PIVOT_DESKTOP_SQLITE_MANIFEST; else process.env.PIVOT_DESKTOP_SQLITE_MANIFEST = original;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
