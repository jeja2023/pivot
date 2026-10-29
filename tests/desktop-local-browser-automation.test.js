const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const http = require('node:http');
const { chromium } = require('playwright');
const { isHeadlessEnvironment } = require('../server/services/agent-browser');
const { profileDirectory, resolveGrantedBrowser, runLocalBrowserTask } = require('../desktop/local-browser-automation');

test('桌面本机浏览器仅解析已授权可执行文件并将 Profile 限制在专属根目录', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-local-browser-'));
    const executable = path.join(root, process.platform === 'win32' ? 'msedge.exe' : 'firefox');
    fs.writeFileSync(executable, 'fixture');
    try {
        const browser = resolveGrantedBrowser({
            browsers: [{ id: 'firefox-test', label: 'Firefox', engine: 'firefox', executablePath: executable }]
        }, 'firefox-test');
        assert.equal(browser.executablePath, path.resolve(executable));
        const profile = profileDirectory(path.join(root, 'profiles'), browser.id);
        assert.equal(profile.startsWith(path.join(root, 'profiles')), true);
        assert.equal(fs.existsSync(profile), true);
        assert.throws(
            () => resolveGrantedBrowser({ browsers: [] }, 'firefox-test'),
            error => error.code === 'LOCAL_BROWSER_NOT_AUTHORIZED'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});


const browserExecutable = process.env.PIVOT_TEST_DESKTOP_BROWSER || chromium.executablePath();
test('桌面本机浏览器真实打开、读取、点击、截图并执行确认', { skip: isHeadlessEnvironment() || !fs.existsSync(browserExecutable) ? '缺少可见桌面或 Chromium' : false, timeout: 60000 }, async t => {
    const address = Object.values(os.networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.'))?.address;
    if (!address) return t.skip('没有可供隔离测试的本机网络地址');
    let clicks = 0;
    const server = http.createServer((req, res) => {
        if (req.url === '/mark') { clicks++; res.writeHead(204); res.end(); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>测试页面</title></head><body><p>测试内容</p><button id="send" onclick="fetch(\'/mark\')">提交</button></body></html>');
    });
    await new Promise(resolve => server.listen(0, address, resolve));
    const url = `http://${address}:${server.address().port}/`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-local-browser-real-'));
    const previous = process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    const grant = { browsers: [{ id: 'local-test', label: '测试浏览器', engine: 'chromium', executablePath: browserExecutable }], allowedOrigins: [new URL(url).origin] };
    const confirmations = [];
    const execute = (toolName, input = {}, accept = true) => runLocalBrowserTask({ toolName, input: { browserId: 'local-test', url, ...input }, grant, profileRoot: root, confirmAction: async details => { confirmations.push(details.kind); return accept; } });
    try {
        let release;
        let reached;
        const confirmed = new Promise(resolve => { reached = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        const opening = runLocalBrowserTask({ toolName: 'browser.open', input: { browserId: 'local-test', url }, grant, profileRoot: root, confirmAction: async () => { reached(); await gate; return true; } });
        try {
            await confirmed;
            await assert.rejects(() => execute('browser.inspect'), error => error.code === 'LOCAL_BROWSER_BUSY');
        } finally { release(); }
        assert.equal((await opening).action, 'opened');
        assert.match((await execute('browser.inspect')).text, /测试内容/);
        await assert.rejects(() => execute('browser.click', { target: { selector: '#send' } }, false), error => error.code === 'LOCAL_BROWSER_USER_CANCELLED');
        assert.equal(clicks, 0);
        assert.equal((await execute('browser.click', { target: { selector: '#send' } })).action, 'clicked');
        assert.equal(clicks, 1);
        assert.equal((await execute('browser.screenshot')).screenshot.mimeType, 'image/png');
        assert.deepEqual(confirmations, ['inspect', 'click', 'click', 'screenshot']);
    } finally {
        if (previous === undefined) delete process.env.ALLOW_SENSITIVE_OUTBOUND_URLS; else process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = previous;
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
