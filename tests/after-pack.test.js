const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const afterPack = require('../scripts/after-pack');
const packageJson = require('../package.json');

test('after-pack 仅保留当前平台 better-sqlite3 原生模块并移除构建源文件', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-after-pack-'));
    const packageRoot = path.join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3');
    const prebuilds = path.join(packageRoot, 'prebuilds');
    try {
        fs.mkdirSync(path.join(packageRoot, 'deps'), { recursive: true });
        fs.mkdirSync(path.join(packageRoot, 'src'), { recursive: true });
        fs.mkdirSync(prebuilds, { recursive: true });
        ['win32-x64.node', 'linux-x64.node', 'linuxmusl-x64.node', 'darwin-x64.node'].forEach(name => fs.writeFileSync(path.join(prebuilds, name), 'native'));
        fs.writeFileSync(path.join(packageRoot, 'binding.gyp'), 'gyp');
        await afterPack({ appOutDir: root, electronPlatformName: 'win32', arch: 1 });
        assert.deepEqual(fs.readdirSync(prebuilds), ['win32-x64.node']);
        assert.equal(fs.existsSync(path.join(packageRoot, 'deps')), false);
        assert.equal(fs.existsSync(path.join(packageRoot, 'src')), false);
        assert.equal(fs.existsSync(path.join(packageRoot, 'binding.gyp')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('桌面包不携带纯类型文件或 Node 运行时不用的浏览器 MSAL 包', () => {
    const files = packageJson.build.files;
    assert.ok(files.includes('!node_modules/@types/**'));
    assert.ok(files.includes('!node_modules/@azure/msal-browser/**'));
});
