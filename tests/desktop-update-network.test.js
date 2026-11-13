'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const os = require('node:os');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { installStealthHeaderInterceptor } = require('../desktop/stealth-policy');
const { normalizeConfig, mergeDesktopConfigs } = require('../desktop/config');

test('更新会话沿用既有 v1/v2 隐身签名，每次请求使用当前连接与密钥', t => {
    let listener;
    const session = { webRequest: { onBeforeSendHeaders(callback) { listener = callback; } } };
    let target = 'http://pivot.test:9006/';
    let secret = 'original-stealth-secret';
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    installStealthHeaderInterceptor(session, { getTargetUrl: () => target, getSecret: () => secret });
    const request = url => {
        let result;
        listener({ url, requestHeaders: { Accept: '*/*', 'X-Pivot-Stealth-Time': 'old' } }, value => { result = value.requestHeaders; });
        return result;
    };
    const first = request('http://pivot.test:9006/downloads/latest.yml');
    assert.equal(first['X-Pivot-Stealth-Version'], '2');
    assert.equal(first['X-Pivot-Stealth-Token'], crypto.createHmac('sha256', secret).update('1000').digest('hex'));
    assert.equal(first['X-Pivot-Stealth-Token-V2'], crypto.createHmac('sha256', secret).update('1000:pivot.test:9006').digest('hex'));
    now = 2000;
    target = 'http://pivot-next.test:9007/';
    secret = 'updated-stealth-secret';
    const next = request('http://pivot-next.test:9007/downloads/Pivot.exe');
    assert.equal(next['X-Pivot-Stealth-Time'], '2000');
    assert.equal(next['X-Pivot-Stealth-Token-V2'], crypto.createHmac('sha256', secret).update('2000:pivot-next.test:9007').digest('hex'));
    const external = request('https://independent-updates.test/latest.yml');
    assert.deepEqual(external, { Accept: '*/*' });
    const main = fs.readFileSync(path.join(__dirname, '../desktop/main.js'), 'utf8');
    assert.match(main, /attachStealthHeaderInterceptor\(getUpdaterNetSession\(\)\)/);
});

test('本地模式停用无法推导的同站更新，切回远程后保持原更新策略', () => {
    const base = { mode: 'remote', remoteUrl: 'http://pivot.test:9006/', autoUpdate: { enabled: true, url: '', path: '/downloads/', allowedOrigins: ['http://pivot.test:9006'], allowInsecureHttp: true, publisherName: 'Pivot Local Dev', allowUntrustedRoot: true, certificateSha256: 'ab'.repeat(32), installOnQuit: false } };
    const remote = normalizeConfig(base, {}, {});
    assert.deepEqual(remote.autoUpdate, { enabled: true, url: 'http://pivot.test:9006/downloads/', path: '/downloads/', checkOnStart: true, checkIntervalMinutes: 30, autoDownload: true, allowPrerelease: false, publisherName: 'Pivot Local Dev', allowUntrustedRoot: true, certificateSha256: 'ab'.repeat(32), allowInsecureHttp: true, installOnQuit: false, allowedOrigins: ['http://pivot.test:9006'] });
    const localRaw = mergeDesktopConfigs(base, { mode: 'local' });
    const local = normalizeConfig(localRaw, {}, {});
    assert.equal(local.autoUpdate.enabled, false);
    assert.equal(local.autoUpdate.url, '');
    assert.equal(localRaw.autoUpdate.enabled, true);
    const restored = normalizeConfig(mergeDesktopConfigs(localRaw, { mode: 'remote' }), {}, {});
    assert.deepEqual(restored.autoUpdate, remote.autoUpdate);
    const independent = normalizeConfig({ ...base, mode: 'local', autoUpdate: { ...base.autoUpdate, url: 'https://updates.test/pivot/', allowedOrigins: ['https://updates.test'] } }, {}, {});
    assert.equal(independent.autoUpdate.enabled, true);
    assert.equal(independent.autoUpdate.url, 'https://updates.test/pivot/');
});

test('真实 Electron 更新器独立会话在既有隐身协议下读取元数据和安装资源', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-update-network-'));
    const accepted = [];
    const server = http.createServer((req, res) => {
        const timestamp = String(req.headers['x-pivot-stealth-time'] || '');
        const host = String(req.headers.host || '').toLowerCase();
        const expectedV2 = crypto.createHmac('sha256', 'updater-network-test-secret').update(timestamp + ':' + host).digest('hex');
        const expectedV1 = crypto.createHmac('sha256', 'updater-network-test-secret').update(timestamp).digest('hex');
        if (req.headers['x-pivot-stealth-token-v2'] !== expectedV2 || req.headers['x-pivot-stealth-token'] !== expectedV1) {
            req.socket.destroy();
            return;
        }
        accepted.push(req.url);
        res.end('受控更新资源');
    });
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const env = { ...process.env, PIVOT_UPDATE_NETWORK_TEST_ROOT: root, PIVOT_UPDATE_NETWORK_TEST_URL: `http://127.0.0.1:${server.address().port}/` };
        delete env.ELECTRON_RUN_AS_NODE;
        await promisify(execFile)(require('electron'), [path.join(__dirname, 'fixtures/desktop-update-network-electron.js')], { windowsHide: true, env, timeout: 45000 });
        const result = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
        assert.ok(result.before.error);
        assert.deepEqual(result.after.map(item => item.status), [200, 200, 200]);
        assert.deepEqual(accepted, ['/downloads/latest.yml', '/downloads/Pivot.exe', '/downloads/Pivot.exe.blockmap']);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        assert.equal(path.dirname(root), os.tmpdir());
        fs.rmSync(root, { recursive: true, force: true });
    }
});
