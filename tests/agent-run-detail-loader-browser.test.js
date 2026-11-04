'use strict';
/* global window, document */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

test('任务详情立即显示加载、失败可重试、切换或关闭后迟到响应不覆盖新任务', { timeout: 60000 }, async () => {
    const app = express(); app.use('/chat', express.static(path.resolve('client/chat')));
    app.get('/fixture.js', (_req, res) => res.type('js').send(`
        window.Pivot={legacy:{},exposeModule:(_,api)=>{window.loader=api;}};
        window.API_BASE='/api'; window.apiFetch=(...args)=>fetch(...args);
        window.Pivot.legacy.ensureWorkspaceScripts=()=>new Promise(resolve=>{window.finishModules=()=>{window.Pivot.legacy.openAgentRun=id=>{document.body.dataset.run=id;};resolve();};});
        window.originalSetTimeout=window.setTimeout;
        window.setTimeout=(fn,ms)=>window.originalSetTimeout(fn,ms===12000?100:ms);
    `));
    app.get('/api/agents/runs/:id', (req, res) => {
        if (req.params.id === 'slow') return setTimeout(() => res.json({ run: { id: 'slow' } }), 500);
        if (req.params.id === 'failed') return res.status(503).json({ error: '诊断服务暂时不可用' });
        res.json({ run: { id: req.params.id }, detailLevel: req.query.view || '完整' });
    });
    app.get('/', (_req, res) => res.send('<!doctype html><meta charset="utf-8"><div id="output"></div><script src="/fixture.js"></script><script src="/chat/agent-run-detail-loader.js"></script>'));
    const service = http.createServer(app); await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true, executablePath: require('../server/services/agent-browser').resolveChromiumExecutable(chromium) });
        const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${service.address().port}/`);
        await page.evaluate(() => { window.loader.openFromChat('old'); });
        await page.getByRole('dialog', { name: '任务详情' }).waitFor();
        assert.match(await page.getByRole('status').innerText(), /正在准备/);
        await page.getByRole('button', { name: '关闭', exact: true }).click();
        await page.evaluate(() => window.finishModules());
        assert.equal(await page.locator('body').getAttribute('data-run'), null);
        await page.evaluate(() => { window.loader.openFromChat('current'); });
        await page.waitForFunction(() => document.body.dataset.run === 'current');
        const summary = await page.evaluate(async () => (await window.loader.read('current')).data.detailLevel);
        assert.equal(summary, 'overview');
        const full = await page.evaluate(async () => (await window.loader.read('current', true)).data.detailLevel);
        assert.equal(full, '完整');
        assert.equal(await page.evaluate(async () => (await window.loader.read('current')).data.detailLevel), '完整');
        await page.evaluate(async () => {
            const previous = window.loader.readOrShowFailure('slow', {}, document.getElementById('output'), () => false);
            await window.loader.read('new'); await previous;
        });
        assert.equal(await page.locator('#output').innerText(), '');
        await page.evaluate(async () => { await window.loader.readOrShowFailure('slow', {}, document.getElementById('output'), () => true); });
        assert.match(await page.locator('#output').innerText(), /超过等待时间/);
        assert.equal(await page.getByRole('button', { name: '重试加载' }).count(), 1);
        await page.getByRole('button', { name: '重试加载' }).click();
        assert.equal(await page.locator('body').getAttribute('data-run'), 'slow');
        await page.evaluate(() => { window.loader.showFailure(document.getElementById('output'), new Error('<img onerror=alert(1)>'), () => {}); });
        assert.equal(await page.locator('#output img').count(), 0);
        await page.evaluate(async () => { await window.loader.readOrShowFailure('failed', {}, document.getElementById('output'), () => true); });
        assert.match(await page.locator('#output').innerText(), /诊断服务暂时不可用/);
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok((await page.locator('#output').boundingBox()).width <= 390);
    } finally { await browser?.close(); service.closeAllConnections?.(); await new Promise(resolve => service.close(resolve)); }
});
