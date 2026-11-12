'use strict';
/* global window, document */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const helmet = require('helmet');
const { chromium } = require('playwright');
const { normalizeCodeFile } = require('../server/services/agent-code-renditions');

const source = 'flowchart TD\n    A([开始]) --> B[用户登录]\n    B --> C{验证账号}\n    C -->|成功| D([登录成功])';

async function fixture(run) {
    const app = express(); const calls = [];
    app.use(express.json());
    app.use(helmet({ crossOriginEmbedderPolicy: false, crossOriginOpenerPolicy: false, originAgentCluster: false, hsts: false,
        contentSecurityPolicy: { directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'script-src': ["'self'", 'blob:'],
            'script-src-elem': ["'self'", 'blob:'], 'img-src': ["'self'", 'data:', 'blob:'], 'frame-src': ["'self'", 'blob:'],
            'style-src': ["'self'", "'unsafe-inline'"], 'connect-src': ["'self'"], 'upgrade-insecure-requests': null } } }));
    require('../server/routes/mermaid-preview-assets').registerMermaidPreviewAssets(app);
    app.use('/chat', express.static(path.resolve('client/chat')));
    app.use('/common', express.static(path.resolve('client/common')));
    app.get('/fixture.js', (_req, res) => res.type('js').send(`
        window.Pivot = { legacy: { currentUser: { id: 1 } }, modules: {}, moduleApi(name) { return this.modules[name] || {}; }, exposeModule(name, value) { this.modules[name] = value; } };
        window.Pivot.legacy.showToast = () => {};
        window.addEventListener('message', event => { if (event.data?.type === 'pivot:mermaid-result') window.lastMermaidResult = event.data; });
        window.showToast = () => {};
        window.API_BASE = '/api';
        window.currentSessionId = 'mermaid-session';
        window.apiFetch = (url, options) => fetch(url, options);
        const device = { available: true, registered: true, deviceId: 'test-device', grants: [{ grantId: 'text-grant', allowedFormats: ['txt', 'svg'] }] };
        window.pivotDesktop = { getDeliveryStatus: async () => device, prepareDelivery: async () => device, startDelivery: async () => {} };
    `));
    app.post('/api/agents/code-renditions', (req, res) => {
        const normalized = normalizeCodeFile(req.body);
        calls.push({ route: 'code', body: req.body, normalized });
        res.json({ rendition: { id: 'source-file', format: normalized.format } });
    });
    app.post('/api/agents/deliveries', (req, res) => { calls.push({ route: 'delivery', body: req.body }); res.json({ intent: { id: 'delivery-one' } }); });
    app.get('/', (_req, res) => res.send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="/common/styles/theme.css"><link rel="stylesheet" href="/chat/chat.shell.css">
        <script defer src="/common/vendor/marked.min.js"></script><script defer src="/common/vendor/purify.min.js"></script><script defer src="/fixture.js"></script><script defer src="/chat/safe-html.js"></script>
        <script defer src="/common/code-formats.js"></script><script defer src="/chat/mermaid-svg.js"></script><script defer src="/chat/mermaid-runtime.js"></script><script defer src="/chat/render-mermaid.js"></script><script defer src="/chat/render-markdown-emphasis.js"></script>
        <script defer src="/chat/render.js"></script><script defer src="/chat/render-charts.js"></script><script defer src="/chat/render-messages.js"></script><script defer src="/chat/code-delivery.js"></script>
        <script defer src="/chat/chat-task-state.js"></script><script defer src="/chat/chat-task-render.js"></script><script defer src="/chat/chat-task-controller.js"></script>
        </head><body><main class="text-body" id="answer"></main></body></html>`));
    const service = http.createServer(app);
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        page.on('console', message => { if (message.type() === 'error') console.error(`图形测试控制台：${message.text().slice(0, 500)}`); });
        await page.goto(`http://127.0.0.1:${service.address().port}/`);
        await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('chat.mermaid').markup));
        try { await run({ page, calls }); }
        catch (error) {
            console.error(`图形测试状态：${await page.locator('.mermaid-status').allTextContents()}`);
            console.error(`图形测试元素：${await page.evaluate(() => {
                const svg = window.lastMermaidResult?.svg;
                if (!svg) return '未取得 SVG';
                const safe = window.Pivot.html.sanitizeHtml(svg, { USE_PROFILES: { svg: true }, FORBID_TAGS: ['foreignObject', 'image', 'a', 'animate', 'set'] });
                const doc = new window.DOMParser().parseFromString(safe, 'image/svg+xml');
                return JSON.stringify([...new Set([...doc.querySelectorAll('*')].map(node => node.localName + ':' + node.namespaceURI))]);
            })}`);
            throw error;
        }
    } finally { await browser?.close(); service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); }
}

async function show(page, text = source, streaming = false, diagramResultFiles = false) {
    await page.evaluate(({ text, streaming, diagramResultFiles }) => {
        const box = document.getElementById('answer');
        window.Pivot.html.setHtml(box, window.Pivot.legacy.renderMarkdown(text, { streaming, diagramResultFiles }));
        window.Pivot.legacy.renderPivotCharts(box);
    }, { text, streaming, diagramResultFiles });
}

test('截图流程图默认预览，源码切换、复制、下载 SVG 与源码保存分别工作', { timeout: 90000 }, async () => fixture(async ({ page, calls }) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await show(page, '流程图已生成\n\n```mermaid\n' + source + '\n```');
    await page.locator('[data-mermaid-action="download-svg"]:enabled').waitFor({ timeout: 30000 });
    assert.equal(await page.locator('.mermaid-image').isVisible(), true);
    assert.equal(await page.locator('.mermaid-source').isVisible(), false);
    assert.equal(await page.locator('iframe.mermaid-render-host').getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await page.locator('iframe.mermaid-render-host').evaluate(frame => frame.contentDocument), null);
    const resource = await page.request.get(new URL('/common/mermaid-assets/runtime.js', page.url()).href);
    assert.equal(resource.headers()['access-control-allow-origin'], '*');
    assert.equal(resource.headers()['cross-origin-resource-policy'], 'cross-origin');
    const ordinary = await page.request.get(new URL('/chat/render.js', page.url()).href);
    assert.equal(ordinary.headers()['cross-origin-resource-policy'], 'same-origin');
    assert.equal(ordinary.headers()['access-control-allow-origin'], undefined);
    await page.locator('[data-mermaid-action="source"]').click();
    assert.equal(await page.locator('.mermaid-source').isVisible(), true);
    assert.equal(await page.locator('.mermaid-source code').textContent(), source);
    await page.locator('[data-mermaid-action="copy-source"]').click();
    await page.waitForFunction(() => document.querySelector('[data-mermaid-action="copy-source"]').textContent.includes('已复制'));
    assert.match(await page.locator('[data-mermaid-action="copy-source"]').textContent(), /已复制/);
    await page.locator('[data-mermaid-action="preview"]').click();
    const downloading = page.waitForEvent('download');
    await page.locator('[data-mermaid-action="download-svg"]').click();
    const download = await downloading;
    const svg = await fs.readFile(await download.path(), 'utf8');
    assert.match(svg, /<svg/); assert.match(svg, /用户登录/); assert.match(svg, /验证账号/); assert.match(svg, /开始/);
    assert.doesNotMatch(svg, /foreignObject|<script|onload=|href="https?:/i);
    page.once('dialog', dialog => dialog.accept('流程图源码.txt'));
    const saved = page.waitForResponse(response => response.url().endsWith('/api/agents/deliveries'));
    await page.locator('[data-mermaid-action="save-source"]').click();
    await saved;
    await page.waitForFunction(() => !document.querySelector('[data-mermaid-action="save-source"]').disabled);
    assert.equal(calls[0].body.content, source); assert.equal(calls[0].body.filename, '流程图源码.txt');
    assert.equal(calls[0].body.language, 'mermaid'); assert.equal(calls[1].body.renditionId, 'source-file');
    await fs.mkdir(path.resolve('output/mermaid-preview'), { recursive: true });
    await page.screenshot({ path: path.resolve('output/mermaid-preview/light.png'), fullPage: true, animations: 'disabled' });
    for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        const bounds = await page.locator('.mermaid-card').evaluate(element => ({ content: element.scrollWidth, width: element.clientWidth }));
        assert.ok(bounds.content <= bounds.width + 2, JSON.stringify(bounds));
        await page.locator('[data-mermaid-action="expand"]').click();
        await page.locator('[data-mermaid-viewer="in"]').click();
        assert.equal(await page.locator('.mermaid-viewer img').getAttribute('width') !== null, true);
        await page.locator('[data-mermaid-viewer="reset"]').click();
        assert.equal(await page.locator('.mermaid-viewer img').getAttribute('width'), null);
        assert.equal(await page.locator('.mermaid-viewer .workspace-modal-header').evaluate(header => {
            const box = header.getBoundingClientRect();
            return [...header.querySelectorAll('button')].every(button => {
                const bounds = button.getBoundingClientRect();
                return bounds.top >= box.top && bounds.bottom <= box.bottom && bounds.right <= box.right;
            });
        }), true);
        if (width === 390) await page.screenshot({ path: path.resolve('output/mermaid-preview/mobile-viewer.png'), fullPage: true, animations: 'disabled' });
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.mermaid-viewer').count(), 0);
    }
    await page.screenshot({ path: path.resolve('output/mermaid-preview/mobile.png'), fullPage: true, animations: 'disabled' });
    const lightSource = await page.locator('.mermaid-image').getAttribute('src');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(previous => document.querySelector('.mermaid-image').src !== previous && !document.querySelector('[data-mermaid-action="download-svg"]').disabled, lightSource);
    await page.locator('[data-mermaid-action="download-svg"]:enabled').waitFor({ timeout: 20000 });
    await page.screenshot({ path: path.resolve('output/mermaid-preview/dark-mobile.png'), fullPage: true, animations: 'disabled' });
    assert.deepEqual(errors, []);
}));

test('绘图资源失败立即显示错误，重试重新加载并完成预览', { timeout: 90000 }, async () => fixture(async ({ page }) => {
    await page.route('**/common/mermaid-assets/runtime.js', route => route.abort());
    await show(page, '```mermaid\n' + source + '\n```');
    await page.locator('.mermaid-retry:not(.hidden)').waitFor({ timeout: 10000 });
    assert.match(await page.locator('.mermaid-status').textContent(), /加载失败/);
    assert.equal(await page.locator('[data-mermaid-action="download-svg"]').isDisabled(), true);
    await page.unroute('**/common/mermaid-assets/runtime.js');
    await page.locator('[data-mermaid-action="retry"]').click();
    await page.locator('[data-mermaid-action="download-svg"]:enabled').waitFor({ timeout: 30000 });
    assert.equal(await page.locator('.mermaid-image').isVisible(), true);
}));

test('已有 SVG 结果时正文只保留折叠源码和复制，展开也不恢复重复按钮', { timeout: 90000 }, async () => fixture(async ({ page }) => {
    let requests = 0;
    page.on('request', request => { if (request.url().includes('/common/mermaid-assets/')) requests++; });
    await show(page, '流程图结构\n\n```mermaid\n' + source + '\n```', false, true);
    assert.equal(await page.locator('.mermaid-supplement').getAttribute('open'), null);
    assert.equal(await page.locator('iframe.mermaid-render-host').count(), 0);
    assert.equal(requests, 0);
    assert.equal(await page.locator('[data-mermaid-action="download-svg"]').count(), 0);
    await page.locator('.mermaid-supplement summary').click();
    assert.equal(await page.locator('code').textContent(), source);
    await page.locator('[data-mermaid-action="copy-source"]').click();
    await page.waitForFunction(() => document.querySelector('[data-mermaid-action="copy-source"]').textContent.includes('已复制'));
    assert.deepEqual(await page.locator('[data-mermaid-action]').evaluateAll(buttons => buttons.map(button => button.dataset.mermaidAction)), ['copy-source']);
    assert.equal(await page.locator('iframe.mermaid-render-host').count(), 0);
    assert.equal(requests, 0);
    await fs.mkdir(path.resolve('output/mermaid-preview'), { recursive: true });
    await page.screenshot({ path: path.resolve('output/mermaid-preview/result-file-source.png'), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await page.locator('.mermaid-supplement').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
    assert.ok(bounds.content <= bounds.width + 2);
    await page.screenshot({ path: path.resolve('output/mermaid-preview/result-file-source-mobile.png'), fullPage: true, animations: 'disabled' });
    await show(page, '```mermaid\n' + source + '\n```');
    await page.locator('[data-mermaid-action="download-svg"]:enabled').waitFor();
    assert.equal(await page.locator('.mermaid-supplement').count(), 0);
}));

test('真实任务呈现保留结果文件入口，文件就绪或失效时同步切换正文源码与预览', { timeout: 90000 }, async () => fixture(async ({ page }) => {
    await page.evaluate(definition => {
        const host = document.getElementById('answer');
        window.Pivot.html.setHtml(host, '<div class="chat-task-execution"></div><div class="text-body"></div>');
        const state = window.Pivot.moduleApi('chat.taskState').create('run', 'mermaid-session');
        state.run = { ...state.run, status: 'completed', final_answer: '```mermaid\n' + definition + '\n```' };
        state.connection = 'connected'; state.highWater = 1;
        state.artifacts = [{ id: 'svg-artifact', title: '结构图', version: 1, rendition: { id: 'svg-file', format: 'svg', ready: true } }];
        window.diagramTaskEntry = { state, element: host, panel: host.querySelector('.chat-task-execution'), epoch: 0, perform() {} };
        window.Pivot.moduleApi('chat.tasks').renderEntry(window.diagramTaskEntry);
    }, source);
    assert.equal(await page.locator('.chat-task-artifacts [data-task-action="preview"]').count(), 1);
    assert.equal(await page.locator('.chat-task-artifacts [data-task-action="download"]').count(), 1);
    assert.equal(await page.locator('.mermaid-supplement').count(), 1);
    assert.equal(await page.locator('[data-mermaid-action="download-svg"]').count(), 0);
    assert.deepEqual(await page.locator('.text-body [data-mermaid-action]').evaluateAll(buttons => buttons.map(button => button.dataset.mermaidAction)), ['copy-source']);
    assert.equal(await page.locator('.chat-task-artifacts [data-task-action="save-local"]').count(), 1);
    await page.screenshot({ path: path.resolve('output/mermaid-preview/task-with-result-file.png'), fullPage: true, animations: 'disabled' });
    await page.evaluate(() => {
        window.diagramTaskEntry.state.artifacts = [];
        window.Pivot.moduleApi('chat.tasks').renderEntry(window.diagramTaskEntry);
    });
    await page.locator('[data-mermaid-action="download-svg"]:enabled').waitFor({ timeout: 30000 });
    assert.equal(await page.locator('.mermaid-supplement').count(), 0);
}));

test('流式未闭合代码等待完成，语法失败可以重试，切换账号和移除节点释放预览', { timeout: 90000 }, async () => fixture(async ({ page }) => {
    await show(page, '```mermaid\nflowchart TD\nA -->', true);
    assert.equal(await page.locator('[data-mermaid-card]').getAttribute('data-mermaid-pending'), 'true');
    assert.equal(await page.locator('iframe.mermaid-render-host').count(), 0);
    await show(page, '```mermaid\n' + source + '\n```', true);
    await page.locator('[data-mermaid-action="download-svg"]:enabled').waitFor({ timeout: 30000 });
    await show(page, '```mermaid\nflowchart TD\nA[未闭合\n```');
    await page.locator('.mermaid-retry:not(.hidden)').waitFor({ timeout: 20000 });
    assert.match(await page.locator('.mermaid-status').textContent(), /语法|失败/);
    await page.locator('[data-mermaid-action="retry"]').click();
    await page.locator('.mermaid-retry:not(.hidden)').waitFor({ timeout: 20000 });
    assert.equal(await page.locator('[data-mermaid-action="download-svg"]').isDisabled(), true);
    await show(page, '```mermaid\n' + source + '\n```');
    await page.locator('[data-mermaid-action="download-svg"]:enabled').waitFor({ timeout: 20000 });
    await page.evaluate(() => {
        window.revoked = []; const original = URL.revokeObjectURL.bind(URL);
        URL.revokeObjectURL = url => { window.revoked.push(url); original(url); };
        document.getElementById('answer').replaceChildren();
    });
    await page.waitForFunction(() => window.revoked.length > 0);
    assert.equal(await page.locator('.mermaid-card').count(), 0);
    await show(page, '```mermaid\n' + source + '\n```');
    await page.locator('[data-mermaid-action="download-svg"]:enabled').waitFor();
    await page.evaluate(() => { window.Pivot.legacy.currentUser = { id: 2 }; document.body.classList.add('changed-account'); });
    await page.waitForFunction(() => document.querySelector('.mermaid-card').textContent.includes('账号已切换'));
    assert.equal(await page.locator('.mermaid-image').count(), 0);
}));

test('图形安全检查拒绝外链和动态 SVG，自定义指令不能扩大权限或发起外网请求', { timeout: 90000 }, async () => fixture(async ({ page }) => {
    const outbound = []; page.on('request', request => { if (!request.url().startsWith(new URL(page.url()).origin) && !request.url().startsWith('blob:')) outbound.push(request.url()); });
    const rejected = await page.evaluate(() => {
        const sanitize = window.Pivot.moduleApi('chat.mermaidSvg').sanitize;
        const base = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">';
        const values = ['<style>rect{fill:url(https://example.com/a)}</style><rect width="10" height="10"/>', '<use href="https://example.com/icon.svg#x"/>'];
        return values.map(value => { try { return sanitize(base + value + '</svg>'); } catch (error) { return error.message; } });
    });
    assert.ok(rejected.every(value => !value.includes('https://example.com')));
    await show(page, '```mermaid\n%%{init: {"securityLevel":"loose","themeCSS":"@import url(https://example.com/evil.css)"}}%%\n' + source + '\n```');
    await page.locator('[data-mermaid-action="download-svg"]:enabled').waitFor({ timeout: 30000 });
    assert.deepEqual(outbound, []);
    assert.equal(await page.locator('#answer svg').count(), 0);
}));

test('时序、类、状态、实体关系、甘特、饼图和思维导图使用同一预览入口', { timeout: 90000 }, async () => fixture(async ({ page }) => {
    const diagrams = [
        'sequenceDiagram\n用户->>系统: 提交登录\n系统-->>用户: 登录成功',
        'classDiagram\n用户 --> 订单\nclass 用户 {\n+登录()\n}',
        'stateDiagram-v2\n[*] --> 等待\n等待 --> 完成\n完成 --> [*]',
        'erDiagram\nCUSTOMER ||--o{ ORDER : places',
        'gantt\ntitle 项目计划\ndateFormat YYYY-MM-DD\nsection 开发\n设计 :a1, 2026-11-05, 2d',
        'pie title 任务分布\n"已完成" : 8\n"待处理" : 2',
        'mindmap\n  root((项目))\n    需求\n    开发'
    ];
    for (const definition of diagrams) {
        await show(page, '```mermaid\n' + definition + '\n```');
        await page.waitForFunction(() => !document.querySelector('[data-mermaid-action="download-svg"]').disabled || !document.querySelector('.mermaid-retry').classList.contains('hidden'));
        assert.equal(await page.locator('[data-mermaid-action="download-svg"]').isDisabled(), false, definition + '\n' + await page.locator('.mermaid-status').textContent());
    }
}));

test('SVG 小白兔默认安全预览，支持源码、下载、本机保存和桌面窄屏放大', { timeout: 90000 }, async () => fixture(async ({ page, calls }) => {
    const rabbit = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><title>小白兔</title><g fill="white" stroke="#999"><ellipse cx="170" cy="95" rx="25" ry="65"/><ellipse cx="230" cy="95" rx="25" ry="65"/><ellipse cx="200" cy="285" rx="90" ry="85"/><circle cx="200" cy="200" r="70"/></g><g fill="black"><circle cx="178" cy="190" r="6"/><circle cx="222" cy="190" r="6"/></g><ellipse cx="200" cy="218" rx="8" ry="6" fill="pink"/></svg>';
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await show(page, '```SVG\n' + rabbit + '\n```');
    await page.locator('[data-mermaid-action="download-svg"]:enabled').waitFor();
    assert.equal(await page.locator('.mermaid-image').isVisible(), true);
    assert.equal(await page.locator('#answer svg, iframe.mermaid-render-host').count(), 0);
    await page.locator('[data-mermaid-action="source"]').click();
    assert.equal(await page.locator('code').textContent(), rabbit);
    await page.locator('[data-mermaid-action="copy-source"]').click();
    await page.waitForFunction(() => document.querySelector('[data-mermaid-action="copy-source"]').textContent.includes('已复制'));
    await page.locator('[data-mermaid-action="preview"]').click();
    const downloading = page.waitForEvent('download');
    await page.locator('[data-mermaid-action="download-svg"]').click();
    const downloaded = await downloading;
    assert.equal(downloaded.suggestedFilename(), '图形.svg');
    const svg = await fs.readFile(await downloaded.path(), 'utf8');
    assert.match(svg, /小白兔/); assert.match(svg, /width="400"/);
    page.once('dialog', dialog => { assert.equal(dialog.defaultValue(), '图形.svg'); return dialog.accept('小白兔.svg'); });
    const saved = page.waitForResponse(response => response.url().endsWith('/api/agents/deliveries'));
    await page.locator('[data-mermaid-action="save-source"]').click();
    await saved;
    assert.equal(calls[0].body.language, 'svg'); assert.equal(calls[0].body.filename, '小白兔.svg');
    assert.equal(calls[0].normalized.mimeType, 'image/svg+xml; charset=utf-8');
    assert.match(calls[0].normalized.content, /小白兔/);
    assert.equal(calls[1].body.targetDirGrant, 'text-grant'); assert.equal(calls[1].body.targetFilename, '小白兔.svg');
    await fs.mkdir(path.resolve('output/svg-preview'), { recursive: true });
    for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        const bounds = await page.locator('.mermaid-card').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
        assert.ok(bounds.content <= bounds.width + 2, JSON.stringify(bounds));
        await page.screenshot({ path: path.resolve(`output/svg-preview/rabbit-${width}.png`), fullPage: true });
        await page.locator('[data-mermaid-action="expand"]').click();
        await page.locator('[data-mermaid-viewer="in"]').click();
        assert.equal(await page.locator('.mermaid-viewer img').isVisible(), true);
        assert.equal(await page.locator('.mermaid-viewer .workspace-modal-header').evaluate(header => [...header.querySelectorAll('button')].every(button => button.getBoundingClientRect().right <= header.getBoundingClientRect().right)), true);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('[data-mermaid-action="expand"]').evaluate(button => button === document.activeElement), true);
    }
    const lightUrl = await page.locator('.mermaid-image').getAttribute('src');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(previous => {
        const image = document.querySelector('.mermaid-image');
        return image.src !== previous && image.complete && image.naturalWidth > 0 && !image.classList.contains('hidden');
    }, lightUrl);
    await page.screenshot({ path: path.resolve('output/svg-preview/rabbit-dark-mobile.png'), fullPage: true });
    await page.evaluate(() => { window.Pivot.legacy.currentUser = { id: 2 }; document.body.classList.add('changed-account'); });
    await page.waitForFunction(() => document.querySelector('.mermaid-card').textContent.includes('账号已切换'));
    assert.deepEqual(errors, []);
}));

test('SVG 支持固定宽高、流式等待、结果文件去重并释放旧图片', { timeout: 90000 }, async () => fixture(async ({ page }) => {
    const svg = '<svg width="200px" height="100"><rect width="200" height="100" fill="pink"/></svg>';
    await show(page, '```svg\n<svg width="200"', true);
    assert.equal(await page.locator('[data-mermaid-card]').getAttribute('data-mermaid-pending'), 'true');
    assert.equal(await page.locator('.mermaid-image').getAttribute('src'), null);
    await show(page, '```svg\n' + svg + '\n```', true);
    await page.locator('[data-mermaid-action="download-svg"]:enabled').waitFor();
    const downloading = page.waitForEvent('download');
    await page.locator('[data-mermaid-action="download-svg"]').click();
    const preview = await fs.readFile(await (await downloading).path(), 'utf8');
    assert.match(preview, /viewBox="0 0 200 100"/); assert.match(preview, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    await page.evaluate(() => {
        window.revoked = []; const original = URL.revokeObjectURL.bind(URL);
        URL.revokeObjectURL = url => { window.revoked.push(url); original(url); };
    });
    await show(page, '```svg\n' + svg + '\n```', false, true);
    await page.waitForFunction(() => window.revoked.length > 0);
    assert.equal(await page.locator('.mermaid-supplement').count(), 1);
    assert.deepEqual(await page.locator('[data-mermaid-action]').evaluateAll(buttons => buttons.map(button => button.dataset.mermaidAction)), ['copy-source']);
    await show(page, '```xml\n' + svg + '\n```');
    assert.equal(await page.locator('[data-mermaid-card]').count(), 0);
    assert.equal(await page.locator('.code-save-local-btn').count(), 1);
}));

test('非法或动态 SVG 保留源码和错误反馈，不能预览、下载或进入本机交付', { timeout: 90000 }, async () => fixture(async ({ page, calls }) => {
    const outbound = []; page.on('request', request => { if (!request.url().startsWith(new URL(page.url()).origin) && !request.url().startsWith('blob:')) outbound.push(request.url()); });
    const base = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">';
    for (const svg of [
        base + '<script>alert(1)</script></svg>', base + '<rect onload="alert(1)"/></svg>',
        base + '<image href="https://example.com/a.png"/></svg>', base + '<use href="https://example.com/a.svg#x"/></svg>',
        base + '<style>@import "https://example.com/a.css";</style></svg>',
        base + '<rect></svg>', '<svg viewBox="0 0 40000 10"/>', '<svg width="100%" height="100%"/>'
    ]) {
        await show(page, '```svg\n' + svg + '\n```');
        await page.locator('.mermaid-retry:not(.hidden)').waitFor();
        assert.equal(await page.locator('[data-mermaid-action="download-svg"]').isDisabled(), true);
        assert.equal(await page.locator('code').textContent(), svg);
        assert.equal(await page.locator('#answer svg').count(), 0);
        page.once('dialog', dialog => dialog.accept('图形.svg'));
        await page.locator('[data-mermaid-action="save-source"]').click();
        await page.waitForFunction(() => !document.querySelector('[data-mermaid-action="save-source"]').disabled);
    }
    assert.deepEqual(calls, []); assert.deepEqual(outbound, []);
}));
