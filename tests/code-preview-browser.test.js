'use strict';
/* global window, document, getComputedStyle */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { chromium } = require('playwright');
const { normalizeCodeFile } = require('../server/services/agent-code-renditions');

async function fixture(run) {
    const app = express(); const calls = []; const files = new Map();
    app.use(express.json({ limit: '3mb' }));
    app.use(helmet({ crossOriginEmbedderPolicy: false, hsts: false, contentSecurityPolicy: { directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'], 'frame-src': ["'self'", 'blob:'], 'connect-src': ["'self'"], 'upgrade-insecure-requests': null
    } } }));
    app.use('/common', express.static(path.resolve('client/common'))); app.use('/chat', express.static(path.resolve('client/chat')));
    app.get('/fixture.js', (_req, res) => res.type('js').send(`
        window.API_BASE = '/api'; window.apiFetch = (url, options) => fetch(url, options); window.showToast = message => { document.getElementById('notice').textContent = message; };
        window.Pivot.legacy.currentUser = { id: 1 };
        const device = { available: true, registered: true, deviceId: 'code-device', grants: [{ grantId: 'code-dir', allowedFormats: [] }] };
        window.pivotDesktop = { getDeliveryStatus: async () => device, prepareDelivery: async () => device, startDelivery: async () => {} };
    `));
    app.post('/api/agents/code-renditions', (req, res) => {
        const file = normalizeCodeFile(req.body); const id = String(files.size + 1); files.set(id, file);
        calls.push({ route: 'code', body: req.body }); res.status(201).json({ artifact: { title: file.filename }, rendition: { id, format: file.format } });
    });
    app.post('/api/agents/renditions/:id/download-token', (req, res) => res.json({ token: req.params.id }));
    app.get('/api/agents/renditions/:id/download', (req, res) => {
        const file = files.get(req.params.id);
        res.setHeader('Content-Type', file.mimeType); res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`); res.send(file.content);
    });
    app.post('/api/agents/deliveries', (req, res) => { calls.push({ route: 'delivery', body: req.body }); res.json({ intent: { id: '交付测试' } }); });
    app.get('/', (_req, res) => res.send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="/common/styles/theme.css"><link rel="stylesheet" href="/chat/chat.shell.css">
        ${['/common/vendor/marked.min.js', '/common/vendor/purify.min.js', '/chat/pivot-core.js', '/chat/safe-html.js', '/common/code-formats.js',
        '/chat/render-code-preview.js', '/chat/render-markdown-emphasis.js', '/chat/render.js', '/chat/render-charts.js', '/chat/render-messages.js', '/chat/code-delivery.js', '/fixture.js'].map(src => `<script defer src="${src}"></script>`).join('')}
        </head><body><main class="text-body" id="answer"></main><p id="notice"></p></body></html>`));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    const service = app.listen(0, '127.0.0.1'); await new Promise(resolve => service.once('listening', resolve));
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(`http://127.0.0.1:${service.address().port}/`); await page.waitForFunction(() => window.Pivot?.moduleApi('chat.codeFormats')?.extensionForLanguage);
        await run({ page, calls });
    } finally { await browser.close(); service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); }
}
async function show(page, language, content, streaming = false) {
    await page.evaluate(({ language, content, streaming }) => {
        const root = document.getElementById('answer');
        window.Pivot.html.setHtml(root, window.Pivot.legacy.renderMarkdown('以下是源码：\n\n```' + language + '\n' + content + (streaming ? '' : '\n```'), { streaming }));
        window.Pivot.legacy.renderPivotCharts(root);
    }, { language, content, streaming });
}

test('HTML/HTM 静态预览隔离脚本、网络、表单和页面样式，保留原始源码下载及本机保存', { timeout: 60000 }, async () => fixture(async ({ page, calls }) => {
    const outbound = []; const errors = [];
    page.on('request', request => { if (!request.url().startsWith(new URL(page.url()).origin) && !request.url().startsWith('blob:')) outbound.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    const source = '<!doctype html><html><head><style>body{background:lightblue;color:navy}h1{font-size:28px} .box{border:2px solid navy;padding:24px}</style></head><body><div class="box"><h1>静态页面示例</h1><p>中文、样式与布局</p></div><script>parent.document.body.textContent="被覆盖";fetch("https://example.com/leak")</script><img src="https://example.com/a.png" onerror="alert(1)"><iframe src="/fixture.js"></iframe><form action="/leak"><input autofocus><button>提交</button></form><a href="https://example.com/leak">外部链接</a></body></html>';
    await show(page, 'HTM', source);
    await page.waitForFunction(() => document.querySelector('.code-preview-status').textContent.includes('脚本和外部资源未加载'));
    const frame = page.locator('.code-preview-frame');
    assert.equal(await frame.getAttribute('sandbox'), '');
    assert.equal(await frame.evaluate(element => element.contentDocument), null);
    const preview = page.frameLocator('.code-preview-frame');
    assert.equal(await preview.locator('h1').textContent(), '静态页面示例');
    assert.equal(await preview.locator('h1').evaluate(element => getComputedStyle(element).color), 'rgb(0, 0, 128)');
    assert.equal(await preview.locator('script,iframe,form,input,button,[href],[src]').count(), 0);
    assert.ok((await frame.getAttribute('srcdoc')).includes("default-src 'none'"));
    assert.equal(await page.locator('#answer h1').count(), 0);
    await page.locator('[data-code-view="source"]').click();
    assert.equal(await page.locator('.code-preview-source').isVisible(), true);
    assert.equal(await page.locator('code').textContent(), source);
    page.once('dialog', dialog => { assert.equal(dialog.defaultValue(), '代码.html'); return dialog.accept('页面.htm'); });
    const downloading = page.waitForEvent('download'); await page.locator('.code-download-btn').click();
    const downloaded = await downloading; assert.equal(downloaded.suggestedFilename(), '页面.html');
    assert.equal(await fs.readFile(await downloaded.path(), 'utf8'), source);
    page.once('dialog', dialog => dialog.accept('页面.htm'));
    const saved = page.waitForResponse(response => response.url().endsWith('/api/agents/deliveries')); await page.locator('.code-save-local-btn').click(); await saved;
    assert.equal(calls.at(-1).body.targetFilename, '页面.html'); assert.equal(calls.at(-1).body.targetDirGrant, 'code-dir');
    await page.locator('[data-code-view="preview"]').click();
    await fs.mkdir(path.resolve('output/code-preview'), { recursive: true });
    for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        const bounds = await page.locator('.code-block').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
        assert.ok(bounds.content <= bounds.width + 2, JSON.stringify(bounds));
        await page.screenshot({ path: path.resolve(`output/code-preview/html-${width}.png`), fullPage: true });
    }
    assert.deepEqual(outbound, []); assert.deepEqual(errors, []);
}));

test('CSV/TSV、配置和语言别名可原样下载，未知语言按 TXT 保存，错误扩展名不创建交付', { timeout: 60000 }, async () => fixture(async ({ page, calls }) => {
    for (const [language, extension, source] of [
        ['csv', 'csv', '姓名,说明\r\n小王,"含逗号,和换行\n\n\n文字"'], ['tsv', 'tsv', '姓名\t数量\n小王\t01'],
        ['jsonl', 'jsonl', '{"名称":"一"}\n{"名称":"二"}'], ['ini', 'ini', '[设置]\nname=测试'], ['toml', 'toml', '[设置]\nname="测试"'],
        ['csharp', 'cs', 'Console.WriteLine("测试");'], ['python3', 'py', 'print("测试")'], ['plaintext', 'txt', '原始文本'],
        ['', 'txt', '没有语言标记'], ['powershell', 'txt', 'Write-Host "原样保存"'], ['constructor', 'txt', '不会读取对象原型']
    ]) {
        await show(page, language, source);
        assert.equal(await page.locator('.code-preview-frame').count(), 0);
        page.once('dialog', dialog => { assert.equal(dialog.defaultValue(), `代码.${extension}`, language); return dialog.accept(`结果.${extension}`); });
        const downloading = page.waitForEvent('download'); await page.locator('.code-download-btn').click();
        const file = await downloading;
        assert.equal(file.suggestedFilename(), `结果.${extension}`);
        assert.equal(await fs.readFile(await file.path(), 'utf8'), source.replace(/\r\n/g, '\n'));
    }
    await show(page, 'unknown', '原始源码');
    const before = calls.length; page.once('dialog', dialog => dialog.accept('危险.exe'));
    await page.locator('.code-save-local-btn').click(); await page.waitForFunction(() => !document.querySelector('.code-save-local-btn').disabled);
    assert.equal(calls.length, before); assert.match(await page.locator('#notice').textContent(), /扩展名/);
}));

test('HTML 流式等待与超限反馈保留源码，移除节点、切换账号和迟到下载不恢复旧内容', { timeout: 60000 }, async () => fixture(async ({ page, calls }) => {
    await show(page, 'html', '<h1>接收中', true);
    assert.equal(await page.locator('.code-preview-frame').count(), 0);
    assert.match(await page.locator('.code-preview-status').textContent(), /正在接收/);
    await show(page, 'html', '<h1>完整页面</h1>');
    await page.frameLocator('.code-preview-frame').locator('h1').waitFor();
    await page.evaluate(() => { document.getElementById('answer').replaceChildren(); });
    assert.equal(page.frames().length, 1);
    await show(page, 'html', '<p>' + '大'.repeat(750000) + '</p>');
    assert.match(await page.locator('.code-preview-status').textContent(), /超过大小限制/);
    assert.equal(await page.locator('.code-preview-frame').count(), 0);
    await show(page, 'html', '<h1>旧账号</h1>');
    await page.frameLocator('.code-preview-frame').locator('h1').waitFor();
    let release; const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/agents/code-renditions', async route => { await held; await route.continue(); });
    page.once('dialog', dialog => dialog.accept('页面.html')); await page.locator('.code-download-btn').click();
    await page.evaluate(() => { window.Pivot.legacy.currentUser = { id: 2 }; document.body.setAttribute('data-theme', 'dark'); });
    await page.waitForFunction(() => document.getElementById('answer').textContent.includes('账号已切换'));
    assert.equal(await page.locator('.code-preview-frame').count(), 0);
    release(); await page.unrouteAll({ behavior: 'wait' });
    assert.equal(calls.filter(call => call.route === 'delivery').length, 0);
}));
