'use strict';
/* global document, agentStepReadableMarkup */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

test('任务详情来源按钮打开引用，失效引用给出安全提示', { timeout: 60000 }, async () => {
    const app = express();
    app.use('/chat', express.static(path.resolve('client/chat')));
    app.get('/api/knowledge/citations/:key', (req, res) => {
        if (req.params.key === 'expired') return res.status(404).json({ error: '来源已失效或不可访问' });
        return res.json({ citation: { document: { title: '制度文档' }, quotedText: '有效片段', locator: {} } });
    });
    app.get('/fixture.js', (_req, res) => res.type('js').send(`
        window.Pivot = { legacy: { showAlert: async (title, copy) => { document.body.dataset.citation = title + ':' + copy; } } };
        window.API_BASE = '/api'; window.apiFetch = fetch; window.authHeaders = () => ({});
        window.showToast = message => { document.body.dataset.notice = message; };
        window.agentEscape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        window.agentEscapeAttr = window.agentEscape;
        window.agentParsePayload = value => typeof value === 'string' ? JSON.parse(value) : value;
        window.agentNormalizeToolPayload = value => value;
    `));
    app.get('/', (_req, res) => res.send(`<!doctype html><meta charset="utf-8"><div id="steps"></div>
        <script src="/fixture.js"></script><script src="/chat/agent-run-step-renderers.js"></script><script src="/chat/knowledge-product.js"></script>`));
    const service = http.createServer(app);
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true, executablePath: require('../server/services/agent-browser').resolveChromiumExecutable(chromium) });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${service.address().port}/`);
        await page.evaluate(() => {
            document.getElementById('steps').innerHTML = agentStepReadableMarkup({ output: { knowledgeSourceVersion: 1, sources: [
                { title: '制度文档', citationKey: 'valid' }, { title: '旧来源', citationKey: 'expired' }
            ] } });
        });
        await page.getByRole('button', { name: '制度文档' }).click();
        await page.waitForFunction(() => document.body.dataset.citation);
        assert.match(await page.locator('body').getAttribute('data-citation'), /制度文档[\s\S]*有效片段/);
        await page.getByRole('button', { name: '旧来源' }).click();
        await page.waitForFunction(() => document.body.dataset.notice);
        assert.equal(await page.locator('body').getAttribute('data-notice'), '来源已失效或不可访问');
    } finally {
        await browser?.close();
        service.closeAllConnections?.();
        await new Promise(resolve => service.close(resolve));
    }
});
