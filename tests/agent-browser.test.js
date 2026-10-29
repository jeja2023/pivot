/* global document, WebSocket, Worker, Blob */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');
const { WebSocketServer } = require('ws');
const {
    assertSafeBrowserEvaluation,
    buildBrowserContextOptions,
    captureAgentScreenshot,
    clickBrowserTarget,
    closeAgentBrowserContext,
    createAgentBrowserContext,
    createControlledLoginFlow,
    isHeadlessEnvironment,
    locateBrowserTarget,
    resolveChromiumExecutable,
    waitForBrowserTarget,
    isAgentBrowserRuntimeAvailable
} = require('../server/services/agent-browser');

function startFixture() {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><title>Agent Fixture</title></head><body><button id="run">Run action</button><p id="result">ready</p><script>document.querySelector("#run").onclick=()=>document.querySelector("#result").textContent="clicked";</script></body></html>');
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

const hasChromium = Boolean(resolveChromiumExecutable(chromium));

test('browser runtime availability follows the actual executable probe', () => {
    assert.equal(isAgentBrowserRuntimeAvailable(), hasChromium);
});

test('browser context enforces isolated profile and DOM/visual interaction', { skip: !hasChromium && '未检测到可用的 Chromium 可执行文件，跳过浏览器交互测试' }, async () => {
    const fixture = await startFixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-browser-test-'));
    const previous = process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    let context;
    try {
        const policy = { allowed_origins: [fixture.url], allowed_ports: [Number(new URL(fixture.url).port)], block_private_ranges: false, block_loopback: false, block_link_local: false };
        context = await createAgentBrowserContext({ profileRoot: root, taskId: 'browser-test', networkPolicy: policy, executablePath: resolveChromiumExecutable(chromium) });
        const page = await context.newPage();
        await page.goto(fixture.url);
        const found = await locateBrowserTarget(page, { selector: '#run' });
        assert.equal(found.method, 'dom');
        assert.deepEqual(await clickBrowserTarget(page, { role: 'button', name: 'Run action' }), { method: 'dom' });
        assert.match(await page.locator('#result').innerText(), /clicked/);
        const screenshot = await captureAgentScreenshot(page);
        assert.ok(Buffer.isBuffer(screenshot) && screenshot.length > 100);
        await assert.rejects(() => captureAgentScreenshot(page, { loginPhase: true }), /登录阶段禁止/);
        assert.throws(() => assertSafeBrowserEvaluation('() => document.cookie'), /禁止读取 Cookie/);
        const visionPage = { locator: () => ({ first() { return this; }, async count() { return 0; }, async isVisible() { return false; } }), getByRole: () => ({ first() { return this; }, async count() { return 0; }, async isVisible() { return false; } }), getByText: () => ({ first() { return this; }, async count() { return 0; }, async isVisible() { return false; } }), screenshot: async () => Buffer.from('png') };
        const visual = await locateBrowserTarget(visionPage, { text: '按钮' }, { visionLocator: async ({ screenshot }) => ({ x: screenshot.length, y: 2 }) });
        assert.equal(visual.method, 'vision');
    } finally {
        await closeAgentBrowserContext(context);
        if (previous === undefined) delete process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
        else process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = previous;
        fs.rmSync(root, { recursive: true, force: true });
        await new Promise(resolve => fixture.server.close(resolve));
    }
});

test('browser context options always use a separate profile and block downloads', () => {
    const options = buildBrowserContextOptions({ profileRoot: os.tmpdir(), taskId: 'safe-profile' });
    assert.match(options.userDataDir, /safe-profile/);
    assert.equal(options.acceptDownloads, false);
    assert.equal(options.serviceWorkers, 'block');
});

test('headless environment detector recognizes CI and explicit flags', () => {
    assert.equal(typeof isHeadlessEnvironment(), 'boolean');
    const originalCI = process.env.CI;
    const originalHeadless = process.env.HEADLESS;
    try {
        process.env.CI = 'true';
        assert.equal(isHeadlessEnvironment(), true);
        delete process.env.CI;
        process.env.HEADLESS = 'true';
        assert.equal(isHeadlessEnvironment(), true);
    } finally {
        if (originalCI !== undefined) process.env.CI = originalCI;
        else delete process.env.CI;
        if (originalHeadless !== undefined) process.env.HEADLESS = originalHeadless;
        else delete process.env.HEADLESS;
    }
});

test('controlled login flow waits for user readiness without exposing credentials', { skip: !hasChromium && '未检测到可用的 Chromium 可执行文件，跳过受控登录测试' }, async () => {
    const fixture = await startFixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-login-test-'));
    const previous = process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    let flow;
    try {
        const policy = { allowed_origins: [fixture.url], allowed_ports: [Number(new URL(fixture.url).port)], block_private_ranges: false, block_loopback: false, block_link_local: false };
        flow = await createControlledLoginFlow({ loginUrl: fixture.url, profileRoot: root, taskId: 'login-test', networkPolicy: policy, executablePath: resolveChromiumExecutable(chromium), headless: true });
        const result = await flow.waitForUserReady({ readySelector: '#run', timeoutMs: 3000 });
        assert.equal(result.authenticated, true);
        assert.throws(() => assertSafeBrowserEvaluation('() => localStorage.getItem("token")'), /禁止读取 Cookie/);
    } finally {
        await flow?.close();
        if (previous === undefined) delete process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
        else process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = previous;
        fs.rmSync(root, { recursive: true, force: true });
        await new Promise(resolve => fixture.server.close(resolve));
    }
});


test('等待目标支持延迟出现、隐藏、移除和超时', { skip: !hasChromium && '未检测到可用的 Chromium' }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent('<div id="hidden" hidden>目标</div>');
        await page.evaluate(() => { setTimeout(() => { document.querySelector('#hidden').hidden = false; }, 200); });
        await waitForBrowserTarget(page, { selector: '#hidden' }, { state: 'visible', timeoutMs: 3000 });
        await page.evaluate(() => { setTimeout(() => { document.querySelector('#hidden').hidden = true; }, 150); });
        await waitForBrowserTarget(page, { selector: '#hidden' }, { state: 'hidden', timeoutMs: 3000 });
        await page.evaluate(() => { setTimeout(() => { document.querySelector('#hidden').remove(); }, 150); });
        await waitForBrowserTarget(page, { selector: '#hidden' }, { state: 'detached', timeoutMs: 3000 });
        await assert.rejects(() => waitForBrowserTarget(page, { selector: '#missing' }, { state: 'visible', timeoutMs: 200 }), /Timeout/);
    } finally { await browser.close(); }
});

test('受控浏览器允许授权站点 WebSocket，拒绝未授权端口', { skip: !hasChromium && '未检测到可用的 Chromium' }, async () => {
    const allowed = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>已授权</body></html>'); });
    let forbiddenHttpCount = 0;
    const forbidden = http.createServer((_req, res) => { forbiddenHttpCount++; res.end('forbidden'); });
    const allowedWs = new WebSocketServer({ server: allowed });
    const forbiddenWs = new WebSocketServer({ server: forbidden });
    let allowedCount = 0;
    let forbiddenCount = 0;
    allowedWs.on('connection', socket => { allowedCount++; socket.close(); });
    forbiddenWs.on('connection', socket => { forbiddenCount++; socket.close(); });
    await new Promise(resolve => allowed.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => forbidden.listen(0, '127.0.0.1', resolve));
    const port = allowed.address().port;
    const origin = `http://127.0.0.1:${port}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-browser-ws-test-'));
    const previous = process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    let context;
    try {
        context = await createAgentBrowserContext({ profileRoot: root, taskId: 'ws', networkPolicy: { allowed_origins: [origin], allowed_ports: [port], block_private_ranges: false, block_loopback: false, block_link_local: false } });
        const page = context.pages()[0] || await context.newPage();
        await page.goto(origin);
        await page.evaluate(async ([a, b]) => {
            await Promise.all([a, b].map(url => new Promise(resolve => {
                const socket = new WebSocket(url);
                const timer = setTimeout(resolve, 2000);
                socket.onclose = () => { clearTimeout(timer); resolve(); };
                socket.onerror = () => { clearTimeout(timer); resolve(); };
            })));
        }, [`ws://127.0.0.1:${port}/ws`, `ws://127.0.0.1:${forbidden.address().port}/ws`]);
        await page.evaluate(async url => {
            const code = `const socket = new WebSocket(${JSON.stringify(url)}); socket.onclose = socket.onerror = () => postMessage('done');`;
            const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
            await new Promise(resolve => { worker.onmessage = resolve; setTimeout(resolve, 2000); });
            worker.terminate();
        }, `ws://127.0.0.1:${forbidden.address().port}/worker`);
        await page.evaluate(async url => {
            const code = `const socket = new WebSocket(${JSON.stringify(url)}); socket.onclose = socket.onerror = () => postMessage('done');`;
            const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
            await new Promise(resolve => { worker.onmessage = resolve; setTimeout(resolve, 2000); });
            worker.terminate();
        }, `ws://127.0.0.1:${port}/worker`);
        await page.evaluate(async url => {
            const code = `fetch(${JSON.stringify(url)}).then(() => postMessage('done'), () => postMessage('done'));`;
            const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
            await new Promise(resolve => { worker.onmessage = resolve; setTimeout(resolve, 2000); });
            worker.terminate();
        }, `http://127.0.0.1:${forbidden.address().port}/worker`);
        assert.equal(await page.evaluate(() => typeof globalThis.RTCPeerConnection), 'undefined');
        assert.equal(allowedCount, 2);
        assert.equal(forbiddenCount, 0);
        assert.equal(forbiddenHttpCount, 0);
    } finally {
        await closeAgentBrowserContext(context);
        if (previous === undefined) delete process.env.ALLOW_SENSITIVE_OUTBOUND_URLS; else process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = previous;
        allowedWs.close(); forbiddenWs.close();
        await new Promise(resolve => allowed.close(resolve));
        await new Promise(resolve => forbidden.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
