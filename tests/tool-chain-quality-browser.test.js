'use strict';
/* global window */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

test('质量面板显示样本和成功分母，窄屏可访问且工具名称安全转义', { timeout: 60000 }, async () => {
    const app = express();
    app.use('/chat', express.static(path.resolve('client/chat')));
    app.use('/common', express.static(path.resolve('client/common')));
    app.get('/fixture.js', (_req, res) => res.type('js').send(`
        window.Pivot = { exposeModule: (_, api) => { window.metrics = api; } };
        window.renderFixture = () => {
            const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
            document.getElementById('result').innerHTML = window.metrics.render({ toolChain: {groups:[{tool:'<img src=x onerror=alert(1)>',entrypoint:'workflow',sampleCount:10,succeeded:4,denominator:10,invocationSuccessRate:.4,businessFailures:2,timeouts:1,denied:3,p50Ms:20,p95Ms:80}] } },escape,escape);
        };
    `));
    app.get('/', (_req, res) => res.send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/common/styles/theme.css"><div id="result"></div><script src="/fixture.js"></script><script src="/chat/agent-quality-metrics.js"></script>'));
    const service = http.createServer(app);
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true, executablePath: require('../server/services/agent-browser').resolveChromiumExecutable(chromium) });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${service.address().port}/`);
        await page.evaluate(() => window.renderFixture());
        assert.match(await page.locator('#result').innerText(), /40%（4\/10）/);
        assert.equal(await page.locator('#result img').count(), 0);
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok((await page.getByRole('table').boundingBox()).height > 0);
        assert.equal(await page.getByRole('cell', { name: '2 / 1 / 3', exact: true }).count(), 1);
    } finally {
        await browser?.close(); service.closeAllConnections?.();
        await new Promise(resolve => service.close(resolve));
    }
});
