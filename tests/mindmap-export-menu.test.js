'use strict';
/* global document */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');
const { resolveChromiumExecutable } = require('../server/services/agent-browser');

test('导图后台下载触发时不误关导出下拉菜单，进行中的同任务下载复用单次请求，完成后仍可手动重下', { timeout: 60000 }, async () => {
    const app = express();
    app.use(express.json());
    app.use('/common', express.static(path.resolve('client/common')));
    app.use('/chat', express.static(path.resolve('client/chat')));

    const doc = {
        schemaVersion: 1,
        tree: { id: 'root', text: '菜单回归测试', children: [{ id: 'n1', text: '节点一', children: [] }] },
        presentation: { layout: 'mindMap', themeId: 'indigo', nodes: {} },
        relations: [],
        summaries: []
    };
    const meta = { id: '1', title: '菜单回归测试', versionId: '1', version: 1, role: 'owner', canEdit: true, canExport: true, collaboration: false, document: doc };
    const jobs = new Map();
    const submittedFormats = [];
    let tokenRequests = 0;
    let doneFirstDownload = null;
    let holdFirstDownload = true;
    let signalFirstToken;
    const firstTokenArrived = new Promise(resolve => { signalFirstToken = resolve; });

    app.get('/api/apps/mindmaps', (_req, res) => res.json({ rows: [meta], total: 1, page: 1, limit: 20 }));
    app.get('/api/apps/mindmaps/templates', (_req, res) => res.json({ rows: [] }));
    app.get('/api/apps/mindmaps/themes', (_req, res) => res.json({ rows: [] }));
    app.get('/api/apps/mindmaps/share-targets', (_req, res) => res.json({ users: [] }));
    app.get('/api/apps/mindmaps/:id', (_req, res) => res.json(meta));
    app.post('/api/apps/mindmaps/:id/exports', (req, res) => {
        submittedFormats.push(req.body.format);
        const id = String(submittedFormats.length);
        const job = { id, artifactId: '1', versionId: '1', format: req.body.format, status: 'ready', renditionId: `${id}-${req.body.format}`, error: '' };
        jobs.set(id, job);
        res.status(202).json({ job });
    });
    app.get('/api/apps/mindmaps/exports/:jobId', (req, res) => res.json({ job: jobs.get(req.params.jobId) }));
    app.post('/api/agents/renditions/:id/download-token', async (req, res) => {
        tokenRequests++;
        if (holdFirstDownload) {
            signalFirstToken();
            await new Promise(resolve => { doneFirstDownload = resolve; });
        }
        res.status(201).json({ success: true, token: req.params.id });
    });
    app.get('/api/agents/renditions/:id/download', (req, res) => {
        res.type('application/octet-stream').send(Buffer.from(req.params.id.endsWith('-pdf') ? '%PDF-1.4\n' : '{}'));
    });
    app.get('/fixture.js', (_req, res) => res.type('js').send(`
        window.Pivot.legacy.currentUser = { id: '1' };
        window.Pivot.legacy.apiFetch = (url, options) => fetch(url, options);
        window.Pivot.legacy.showToast = msg => { document.getElementById('toast').textContent = msg; };
        window.Pivot.exposeModule('workspaces.apps', { setStoredAppsActiveApp: () => {} });
        window.Pivot.moduleApi('apps.mindmaps').show({ artifactId: '1' });
    `));
    app.get('/', (_req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8">
        <style>html, body { height: 100%; margin: 0; } .test-root { height: 100vh; display: flex; flex-direction: column; }</style>
        <link rel="stylesheet" href="/common/styles/theme.css"><link rel="stylesheet" href="/chat/chat.workspace.apps.css">
        <button id="apps-back-btn">返回</button><h3 id="apps-workspace-title"></h3><p id="apps-workspace-desc"></p>
        <div class="test-root"><div id="apps-home-view"></div>${fs.readFileSync(path.resolve('client/chat/partials/workspaces/apps-mindmaps.html'), 'utf8')}</div>
        <p id="toast"></p>
        <script src="/chat/pivot-core.js"></script><script src="/common/vendor/purify.min.js"></script><script src="/chat/safe-html.js"></script>
        <script src="/common/mindmap-document.js"></script><script src="/chat/apps-workbench-mindmaps.js"></script><script src="/fixture.js"></script>`));

    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const browser = await chromium.launch({ headless: true, executablePath: resolveChromiumExecutable(chromium) });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.locator('#mindmap-canvas .smm-node').first().waitFor();

        // 1. 触发 json 导出：自动下载进入挂起态后，再次点击“下载文件”应复用同一进行中下载。
        await page.locator('#xmind-export-btn').click();
        await page.locator('[data-mm-action="export-format"][data-format="json"]').click();
        const downloadButton = page.getByRole('button', { name: '下载文件', exact: true });
        await downloadButton.waitFor();
        await firstTokenArrived;
        await downloadButton.click();
        assert.equal(tokenRequests, 1);

        // 2. 在自动下载完成前打开导出下拉菜单；放行下载后菜单不得被编程触发的 link.click() 关闭，可直接提交下一种格式。
        await page.locator('#xmind-export-btn').click();
        await page.locator('#xmind-export-menu').waitFor({ state: 'visible' });
        const firstDownload = page.waitForEvent('download', { predicate: file => file.suggestedFilename().endsWith('.json') });
        holdFirstDownload = false;
        doneFirstDownload();
        await firstDownload;
        assert.equal(await page.locator('#xmind-export-menu').isVisible(), true);

        const pdfSubmitted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/exports'));
        const pdfDownload = page.waitForEvent('download', { predicate: file => file.suggestedFilename().endsWith('.pdf') });
        await page.locator('[data-mm-action="export-format"][data-format="pdf"]').click();
        assert.equal((await pdfSubmitted).status(), 202);
        await pdfDownload;
        assert.deepEqual(submittedFormats, ['json', 'pdf']);

        // 3. 自动下载完成后，点击“下载文件”仍可发起一次新的手动重下。
        await page.waitForFunction(() => document.querySelector('#mindmap-export-status')?.textContent.includes('已自动保存文件'));
        const redownload = page.waitForEvent('download', { predicate: file => file.suggestedFilename().endsWith('.pdf') });
        await downloadButton.click();
        await redownload;
        assert.equal(tokenRequests, 3);
    } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});

