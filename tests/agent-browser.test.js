const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');
const {
    assertSafeBrowserEvaluation,
    buildBrowserContextOptions,
    captureAgentScreenshot,
    clickBrowserTarget,
    closeAgentBrowserContext,
    createAgentBrowserContext,
    createControlledLoginFlow,
    locateBrowserTarget,
    resolveChromiumExecutable
} = require('../server/services/agent-browser');

function startFixture() {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><title>Agent Fixture</title></head><body><button id="run">Run action</button><p id="result">ready</p><script>document.querySelector("#run").onclick=()=>document.querySelector("#result").textContent="clicked";</script></body></html>');
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

const hasChromium = Boolean(resolveChromiumExecutable(chromium));

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

test('controlled login flow waits for user readiness without exposing credentials', { skip: !hasChromium && '未检测到可用的 Chromium 可执行文件，跳过受控登录测试' }, async () => {
    const fixture = await startFixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-login-test-'));
    const previous = process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    let flow;
    try {
        const policy = { allowed_origins: [fixture.url], allowed_ports: [Number(new URL(fixture.url).port)], block_private_ranges: false, block_loopback: false, block_link_local: false };
        flow = await createControlledLoginFlow({ loginUrl: fixture.url, profileRoot: root, taskId: 'login-test', networkPolicy: policy, executablePath: resolveChromiumExecutable(chromium) });
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
