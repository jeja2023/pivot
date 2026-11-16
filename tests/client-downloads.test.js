'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { getClientDownloads } = require('../server/services/client-downloads');
const { publishLocalHelper } = require('../scripts/publish_local_helper');

async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-downloads-'));
    const output = path.join(root, 'dist-local-helper', 'build-fixture');
    await fs.mkdir(output, { recursive: true });
    const filename = 'PivotLocalHelper-Dev-Setup-0.7.164.exe';
    await fs.writeFile(path.join(output, filename), 'MZ synthetic installer');
    await fs.writeFile(path.join(root, 'dist-local-helper', 'latest-build.json'), JSON.stringify({ output, version: '0.7.164', unsigned: true }));
    return { root, output, filename, downloads: path.join(root, 'downloads'), close: () => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

test('未发布、安装包缺失或元数据不匹配时不返回下载地址', async () => {
    const value = await fixture();
    try {
        assert.equal((await getClientDownloads({ root: value.downloads })).localHelper.available, false);
        const manifest = await publishLocalHelper(value);
        const file = path.join(value.downloads, 'local-helper', value.filename);
        const manifestFile = path.join(value.downloads, 'local-helper', 'latest.json');
        for (const patch of [{ filename: '../secret.exe' }, { size: 9999 }, { sha256: 'invalid' }, { channel: 'release' }]) {
            await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, ...patch }));
            const info = await getClientDownloads({ root: value.downloads });
            assert.equal(info.localHelper.available, false);
            assert.equal(info.localHelper.url, undefined);
        }
        await fs.writeFile(manifestFile, JSON.stringify(manifest));
        await fs.unlink(file);
        assert.equal((await getClientDownloads({ root: value.downloads })).localHelper.available, false);
    } finally { await value.close(); }
});

test('发布命令保留验证版标识与校验值，完整客户端开关不影响助手', async () => {
    const value = await fixture();
    try {
        const manifest = await publishLocalHelper(value);
        const info = await getClientDownloads({ root: value.downloads, desktopEnabled: false });
        assert.equal(info.localHelper.available, true);
        assert.equal(info.localHelper.channel, 'development');
        assert.equal(info.localHelper.version, '0.7.164');
        assert.equal(info.localHelper.sha256, manifest.sha256);
        assert.equal(info.localHelper.url, '/downloads/local-helper/' + value.filename);
        assert.equal(info.desktop.available, false);
        assert.doesNotMatch(JSON.stringify(info), /build-fixture|pivot-downloads-/);
        await fs.writeFile(path.join(value.downloads, 'Pivot-Setup.exe'), 'MZ full client');
        assert.equal((await getClientDownloads({ root: value.downloads, desktopEnabled: true })).desktop.available, true);
        assert.equal((await getClientDownloads({ root: value.downloads, desktopEnabled: false })).desktop.available, false);
    } finally { await value.close(); }
});

test('同名内容不可变，缺少签名通道和越出构建目录的包不能发布', async () => {
    const value = await fixture();
    try {
        const first = await publishLocalHelper(value);
        await publishLocalHelper(value);
        await fs.writeFile(path.join(value.output, value.filename), 'MZ modified installer');
        await assert.rejects(publishLocalHelper(value), /同名助手安装包内容不同/);
        assert.equal((await getClientDownloads({ root: value.downloads })).localHelper.sha256, first.sha256);
        const record = path.join(value.root, 'dist-local-helper', 'latest-build.json');
        await fs.writeFile(record, JSON.stringify({ output: value.output, version: '0.7.164' }));
        await assert.rejects(publishLocalHelper(value), /签名通道/);
        await fs.writeFile(record, JSON.stringify({ output: value.root, version: '0.7.164', unsigned: true }));
        await assert.rejects(publishLocalHelper(value), /构建目录/);
    } finally { await value.close(); }
});

test('下载目录不能通过目录链接越出已配置的下载根目录', async () => {
    const value = await fixture();
    try {
        await publishLocalHelper(value);
        const original = path.join(value.downloads, 'local-helper');
        const outside = path.join(value.root, 'outside');
        await fs.rename(original, outside);
        await fs.symlink(outside, original, process.platform === 'win32' ? 'junction' : 'dir');
        assert.equal((await getClientDownloads({ root: value.downloads })).localHelper.available, false);
    } finally { await value.close(); }
});
