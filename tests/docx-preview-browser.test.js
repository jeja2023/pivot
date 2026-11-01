'use strict';
/* global window, document */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { renderDocumentIr } = require('../server/services/document-rendering');

test('真实浏览器点击 DOCX 查看时显示排版内容，并隔离脚本', { timeout: 60000 }, async () => {
    const ir = { ir_version: '1', doc_type: 'report', meta: { title: '旅行方案' }, blocks: [
        { type: 'heading', level: 1, text: '广州之行' }, { type: 'paragraph', runs: [{ text: '行程概述与安排' }] }
    ] };
    const rendered = await renderDocumentIr(ir, 'html');
    const app = express();
    app.use(express.json());
    app.use('/chat', express.static(path.resolve('client/chat')));
    app.use('/common', express.static(path.resolve('client/common')));
    app.post('/api/agents/renditions/13/onlyoffice-preview', (_req, res) => res.json({ onlyoffice: null }));
    app.get('/api/agents/renditions/13/document-preview', (_req, res) => res.json({ html: rendered.buffer.toString('utf8'), imagePlaceholders: false }));
    app.get('/fixture.js', (_req, res) => res.type('js').send(`
        window.Pivot = { legacy: {}, exposeModule: (_, api) => { window.actions = api; }, moduleApi: () => ({ renderEntry() {}, refresh: async () => {} }) };
        window.API_BASE = '/api'; window.apiFetch = fetch; window.showToast = msg => { document.body.dataset.error = msg; };
        window.PivotSafeHtml = { setSrcdoc: (frame, html) => frame.setAttribute('srcdoc', html) };
    `));
    app.get('/', (_req, res) => {
        res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'");
        res.send('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/common/styles/theme.css"><link rel="stylesheet" href="/chat/styles/artifact-viewer.css"><style>body{margin:0}#app{display:flex;height:100vh}aside.sidebar{width:200px;flex:none}.chat-container{flex:1;min-width:0}</style><div id="app"><aside class="sidebar">导航</aside><main class="chat-container"><button id="page-action">原页面操作</button></main></div><script src="/fixture.js"></script><script src="/chat/chat-task-actions.js"></script>');
    });
    const service = http.createServer(app);
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true, executablePath: require('../server/services/agent-browser').resolveChromiumExecutable(chromium) });
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(`http://127.0.0.1:${service.address().port}/`);
        await page.evaluate(() => window.actions.perform({ state: { artifacts: [{ id: '106', title: '旅行方案', rendition: { id: '13', format: 'docx', ready: true } }] } }, 'preview', { dataset: { taskArtifact: '106', taskRendition: '13' } }));
        const panel = page.locator('.chat-result-preview');
        await panel.waitFor({ state: 'visible' });
        const panelBox = await panel.boundingBox();
        assert.ok(panelBox.x > 400 && Math.abs(panelBox.x + panelBox.width - 1280) < 2);
        const chatBox = await page.locator('.chat-container').boundingBox();
        assert.ok(chatBox.x + chatBox.width <= panelBox.x + 1);
        await page.locator('#page-action').click();
        const frame = page.frameLocator('.chat-result-preview iframe');
        assert.equal(await frame.locator('h2').innerText(), '广州之行');
        assert.match(await frame.locator('body').innerText(), /行程概述与安排/);
        assert.equal(await page.locator('.chat-result-preview iframe').getAttribute('sandbox'), '');
        const box = await page.locator('.chat-result-preview iframe').boundingBox();
        assert.ok(box.width > 550 && box.height > 500);
        if (process.env.PIVOT_DOCX_PREVIEW_SCREENSHOT) await page.screenshot({ path: process.env.PIVOT_DOCX_PREVIEW_SCREENSHOT });
        await page.getByRole('button', { name: '关闭预览' }).click();
        await panel.waitFor({ state: 'detached' });
        assert.equal(await panel.count(), 0);
        const restored = await page.locator('.chat-container').boundingBox();
        assert.equal(Math.round(restored.x + restored.width), 1280);
        await page.evaluate(() => {
            document.body.classList.add('pivot-desktop-runtime');
            window.actions.perform({ state: { artifacts: [{ id: '106', title: '旅行方案', rendition: { id: '13', format: 'docx', ready: true } }] } }, 'preview', { dataset: { taskArtifact: '106', taskRendition: '13' } });
        });
        await panel.waitFor({ state: 'visible' });
        const desktopBox = await panel.boundingBox();
        assert.equal(Math.round(desktopBox.y), 30);
        assert.equal(Math.round(desktopBox.height), 900 - 30);
        await page.getByRole('button', { name: '关闭预览' }).click();
        await panel.waitFor({ state: 'detached' });
        await page.evaluate(() => document.body.classList.remove('pivot-desktop-runtime'));
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => window.actions.perform({ state: { artifacts: [{ id: '106', title: '旅行方案', rendition: { id: '13', format: 'docx', ready: true } }] } }, 'preview', { dataset: { taskArtifact: '106', taskRendition: '13' } }));
        await panel.waitFor({ state: 'visible' });
        const mobileBox = await panel.boundingBox();
        assert.equal(Math.round(mobileBox.width), 390);
        await page.getByRole('button', { name: '关闭预览' }).click();
        await panel.waitFor({ state: 'detached' });
    } finally {
        await browser?.close();
        service.closeAllConnections?.();
        await new Promise(resolve => service.close(resolve));
    }
});
