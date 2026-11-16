'use strict';
/* global window, document, renderMcpLocalAuthorizationCenter */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { getClientDownloads } = require('../server/services/client-downloads');
const { publishLocalHelper } = require('../scripts/publish_local_helper');
const { createAuthRouter } = require('../server/routes/auth');
const { loadChatWorkspaceTemplate } = require('../server/chat-template');

async function fixture({ preloadDownloads = true } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-download-browser-'));
    const downloads = path.join(root, 'downloads');
    const build = path.join(root, 'dist-local-helper', 'build-test');
    await fs.mkdir(build, { recursive: true });
    const filename = 'PivotLocalHelper-Dev-Setup-0.7.164.exe';
    await fs.writeFile(path.join(build, filename), 'MZ synthetic helper download');
    await fs.writeFile(path.join(root, 'dist-local-helper', 'latest-build.json'), JSON.stringify({ output: build, version: '0.7.164', unsigned: true }));
    let fail = false, scriptUnavailable = false;
    const scriptRequests = [];
    const pass = (_req, _res, next) => next();
    const app = express();
    app.use('/api', createAuthRouter({ authMiddleware: pass, loginLimiter: pass, registerLimiter: pass, isPublicRegistrationEnabled: () => false, logAction() {},
        getClientDownloads: options => { if (fail) throw new Error('fixture unavailable'); return getClientDownloads({ ...options, root: downloads }); } }));
    app.use('/downloads', express.static(downloads));
    app.get('/chat/client-downloads.js', (req, res, next) => { scriptRequests.push(req.originalUrl); if (scriptUnavailable) return res.status(503).end(); next(); });
    app.use('/chat', express.static(path.resolve('client/chat')));
    app.use('/common', express.static(path.resolve('client/common')));
    const template = await fs.readFile(path.resolve('client/chat/partials/pre-app-modals.html'), 'utf8');
    app.get('/', (_req, res) => res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/common/styles/theme.css"><link rel="stylesheet" href="/chat/chat.css"><link rel="stylesheet" href="/chat/chat.workspace.mcp.css"></head><body class="auth-active">${template}<div id="mcp-local-auth-body"></div></body></html>`));
    app.use((_error, _req, res, _next) => res.status(503).json({ error: 'unavailable' }));
    const server = await new Promise(resolve => { const current = app.listen(0, '127.0.0.1', () => resolve(current)); });
    const browser = await require('playwright').chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.addScriptTag({ path: path.join(path.dirname(require.resolve('dompurify')), 'purify.min.js') });
    for (const script of ['pivot-core.js', 'safe-html.js']) await page.addScriptTag({ path: path.resolve('client/chat', script) });
    await page.evaluate(() => {
        window.API_BASE = '/api'; window.apiFetch = (url, options) => window.fetch(url, options);
        window.mcpEscape = value => { const node = document.createElement('span'); node.textContent = String(value ?? ''); return node.innerHTML; };
        window.Pivot.exposeModule('local.helper', { create: async () => ({ code: 'synthetic-pairing' }), revoke: async () => {} });
    });
    for (const script of [...(preloadDownloads ? ['client-downloads.js'] : []), 'mcp-workbench-local-auth.js']) await page.addScriptTag({ path: path.resolve('client/chat', script) });
    return { page, downloads, publish: () => publishLocalHelper({ root }), fail: value => { fail = value; },
        failScript: value => { scriptUnavailable = value; }, scriptRequests,
        close: async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

test('下载窗口区分助手与完整客户端，真实下载保留版本和开发验证标识', { timeout: 30000 }, async () => {
    const value = await fixture();
    try {
        await value.publish();
        await value.page.locator('#desktop-download-link').click();
        const helper = value.page.locator('#client-downloads-helper');
        await helper.getByRole('link', { name: '下载 Windows 本机助手' }).waitFor();
        assert.match(await helper.textContent(), /v0\.7\.164.*Windows x64.*开发验证版（未签名）/);
        assert.match(await value.page.locator('#client-downloads-desktop').textContent(), /暂未发布/);
        const downloadPromise = value.page.waitForEvent('download');
        await helper.getByRole('link', { name: '下载 Windows 本机助手' }).click();
        const download = await downloadPromise;
        assert.equal(download.suggestedFilename(), 'PivotLocalHelper-Dev-Setup-0.7.164.exe');
        assert.equal(await fs.readFile(await download.path(), 'utf8'), 'MZ synthetic helper download');
        await helper.getByText('安装说明', { exact: true }).click();
        assert.match(await helper.locator('ol').textContent(), /本机授权中心.*配对码/);
        await fs.mkdir(path.resolve('output/local-helper'), { recursive: true });
        await value.page.screenshot({ path: path.resolve('output/local-helper/download-center.png') });
        await value.page.keyboard.press('Escape');
        assert.equal(await value.page.locator('#client-downloads-modal').getAttribute('aria-hidden'), 'true');
        assert.equal(await value.page.evaluate(() => document.activeElement.id), 'desktop-download-link');
    } finally { await value.close(); }
});

test('授权中心在页面未预载下载模块时补载并显示下载卡片', { timeout: 15000 }, async () => {
    const value = await fixture({ preloadDownloads: false });
    try {
        await value.publish();
        await value.page.evaluate(() => {
            document.documentElement.dataset.appVersion = 'v0.7.165';
            document.getElementById('auth-container').classList.add('hidden');
            document.body.classList.remove('auth-active');
            renderMcpLocalAuthorizationCenter({ available: false, grants: {} });
        });
        const body = value.page.locator('#mcp-local-auth-body');
        await body.getByRole('link', { name: '下载 Windows 本机助手' }).waitFor({ timeout: 3000 });
        assert.equal(value.scriptRequests.length, 1);
        assert.match(value.scriptRequests[0], /client-downloads\.js\?v=v0\.7\.165/);
        assert.match(await body.locator('.client-download-meta').textContent(), /v0\.7\.164.*开发验证版/);
        await body.getByRole('button', { name: '生成助手配对码' }).click();
        assert.equal(await body.getByRole('textbox', { name: '助手配对码和状态' }).inputValue(), 'synthetic-pairing');
        await value.page.evaluate(markup => {
            const modal = new window.DOMParser().parseFromString(markup, 'text/html').getElementById('mcp-local-auth-modal');
            const content = document.getElementById('mcp-local-auth-body'), slot = modal.querySelector('#mcp-local-auth-body');
            content.className = slot.className; slot.replaceWith(content);
            modal.classList.remove('hidden'); modal.setAttribute('aria-hidden', 'false');
            document.body.append(modal);
        }, loadChatWorkspaceTemplate('mcp'));
        await value.page.setViewportSize({ width: 850, height: 720 });
        await body.getByRole('link', { name: '下载 Windows 本机助手' }).waitFor();
        await fs.mkdir(path.resolve('output/local-helper'), { recursive: true });
        await value.page.screenshot({ path: path.resolve('output/local-helper/authorization-download-recovered.png') });
    } finally { await value.close(); }
});

test('授权中心下载模块加载失败显示重试入口，恢复后不重复插入卡片', { timeout: 15000 }, async () => {
    const value = await fixture({ preloadDownloads: false });
    try {
        value.failScript(true);
        await value.page.evaluate(() => {
            document.getElementById('auth-container').classList.add('hidden');
            document.body.classList.remove('auth-active');
            renderMcpLocalAuthorizationCenter({ available: false, grants: {} });
        });
        const body = value.page.locator('#mcp-local-auth-body');
        await body.getByText('助手下载信息暂时无法显示，请重试或刷新页面。', { exact: true }).waitFor({ timeout: 3000 });
        await body.getByRole('button', { name: '生成助手配对码' }).click();
        assert.equal(await body.getByRole('textbox', { name: '助手配对码和状态' }).inputValue(), 'synthetic-pairing');
        value.failScript(false);
        await body.getByRole('button', { name: '重试加载助手下载' }).click();
        await body.getByText('暂未发布', { exact: true }).waitFor({ timeout: 3000 });
        assert.equal(await body.locator('.client-download-card').count(), 1);
        assert.equal(await body.locator('a[href]').count(), 0);
        assert.equal(value.scriptRequests.length, 2);
    } finally { await value.close(); }
});

test('未发布和包缺失时没有可点击地址，发布后刷新即可下载', { timeout: 30000 }, async () => {
    const value = await fixture();
    try {
        await value.page.locator('#desktop-download-link').click();
        const helper = value.page.locator('#client-downloads-helper');
        await helper.getByText('暂未发布', { exact: true }).waitFor();
        assert.equal(await helper.locator('a[href]').count(), 0);
        const manifest = await value.publish();
        await helper.getByRole('button', { name: '刷新下载信息' }).click();
        await helper.getByRole('link', { name: '下载 Windows 本机助手' }).waitFor();
        await fs.unlink(path.join(value.downloads, 'local-helper', manifest.filename));
        await helper.getByRole('button', { name: '刷新下载信息' }).click();
        await helper.getByText('暂未发布', { exact: true }).waitFor();
        assert.equal(await helper.locator('a[href]').count(), 0);
        value.fail(true);
        await helper.getByRole('button', { name: '刷新下载信息' }).click();
        await helper.getByText('下载信息暂时不可用，请稍后重试。', { exact: true }).waitFor();
        assert.equal(await helper.locator('a[href]').count(), 0);
    } finally { await value.close(); }
});

test('授权中心顶部直接下载并继续配对，窄屏和深色模式不溢出', { timeout: 30000 }, async () => {
    const value = await fixture();
    try {
        await value.publish();
        await value.page.evaluate(() => {
            document.getElementById('auth-container').classList.add('hidden');
            document.body.classList.remove('auth-active');
            renderMcpLocalAuthorizationCenter({ available: false, deviceName: '当前电脑', grants: {} });
        });
        const body = value.page.locator('#mcp-local-auth-body');
        await body.getByRole('link', { name: '下载 Windows 本机助手' }).waitFor();
        assert.equal(await body.locator(':scope > :first-child').getAttribute('class'), 'mcp-helper-connection');
        await body.getByRole('button', { name: '生成助手配对码' }).click();
        assert.equal(await body.getByRole('textbox', { name: '助手配对码和状态' }).inputValue(), 'synthetic-pairing');
        for (const dark of [false, true]) {
            await value.page.evaluate(dark => document.body.classList.toggle('dark-mode', dark), dark);
            await value.page.setViewportSize({ width: 390, height: 740 });
            assert.ok(await value.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        }
    } finally { await value.close(); }
});
