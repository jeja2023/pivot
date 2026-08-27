const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const http = require('http');
const crypto = require('crypto');

const {
    candidateConfigPaths,
    getUserConfigPath,
    loadDesktopConfig,
    normalizeConfig,
    normalizeRemoteUrl,
    saveUserDesktopConfig
} = require('../desktop/config');
const { isTrustedRendererUrl } = require('../desktop/navigation-policy');

test('Desktop Server Config: 用户自定义配置路径与持久化', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-desktop-config-test-'));
    try {
        const mockApp = {
            getPath(name) {
                if (name === 'userData') return tmpDir;
                return tmpDir;
            },
            isPackaged: false
        };

        const configPath = getUserConfigPath(mockApp);
        assert.equal(configPath, path.join(tmpDir, 'user-config.json'));

        // 保存配置
        const saved = saveUserDesktopConfig(mockApp, {
            mode: 'remote',
            remoteUrl: 'http://192.168.1.88:3000',
            stealthSecret: 'test-secret-12345678'
        });
        assert.equal(saved.mode, 'remote');
        assert.equal(saved.remoteUrl, 'http://192.168.1.88:3000');

        // 验证文件持久化存在且内容正确
        assert.equal(fs.existsSync(configPath), true);
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsed.mode, 'remote');
        assert.equal(parsed.remoteUrl, 'http://192.168.1.88:3000');
        assert.equal(parsed.stealthSecret, 'test-secret-12345678');

        // 候选路径优先级验证：user-config 处于候选列表中并成功加载
        const loadedConfig = loadDesktopConfig(mockApp, [], {});
        assert.equal(loadedConfig.mode, 'remote');
        assert.equal(loadedConfig.remoteUrl, 'http://192.168.1.88:3000/');
        assert.equal(loadedConfig.stealthSecret, 'test-secret-12345678');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Desktop Server Config: URL 格式与协议规范校验', () => {
    assert.equal(normalizeRemoteUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000/');
    assert.equal(normalizeRemoteUrl('https://pivot.mycompany.com:8443/chat#test'), 'https://pivot.mycompany.com:8443/chat');

    assert.throws(() => normalizeRemoteUrl(''), /required/);
    assert.throws(() => normalizeRemoteUrl('ftp://192.168.1.1/'), /must use http or https/);
    assert.throws(() => normalizeRemoteUrl('javascript:alert(1)'), /must use http or https/);
    assert.throws(() => normalizeRemoteUrl('not-a-valid-url'), /Invalid URL/);
});

test('Desktop Server Config: 安全渲染器白名单包含 server-config.html', () => {
    const serverConfigPage = path.join(__dirname, '..', 'desktop', 'server-config.html');
    const allowedOptions = {
        allowedFilePaths: [
            path.join(__dirname, '..', 'desktop', 'error.html'),
            serverConfigPage
        ]
    };
    const fileUrl = pathToFileURL(serverConfigPage).toString();
    assert.equal(isTrustedRendererUrl(fileUrl, 'http://192.168.1.88:3000/', allowedOptions), true);
});

test('Desktop Server Config: 服务端健康探测与签名握手', async () => {
    const secret = 'stealth-secret-token-test-999';
    let receivedHeaderToken = '';
    let receivedHeaderTime = '';

    const server = http.createServer((req, res) => {
        receivedHeaderTime = req.headers['x-pivot-stealth-time'];
        receivedHeaderToken = req.headers['x-pivot-stealth-token'];
        if (req.url === '/api/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    const targetUrl = `http://127.0.0.1:${port}`;

    try {
        const now = Date.now().toString();
        const token = crypto.createHmac('sha256', secret).update(now).digest('hex');

        const res = await fetch(`${targetUrl}/api/health`, {
            headers: {
                'X-Pivot-Stealth-Time': now,
                'X-Pivot-Stealth-Token': token
            }
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.status, 'ok');
        assert.equal(receivedHeaderTime, now);
        assert.equal(receivedHeaderToken, token);
    } finally {
        server.close();
    }
});
