'use strict';
/* global window, document */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

test('字段治理和分析资产进入时等待选择，切换页签与迟到响应不会恢复旧数据', { timeout: 60000 }, async () => {
    const app = express();
    app.use('/chat', express.static(path.resolve('client/chat')));
    app.use('/common', express.static(path.resolve('client/common')));
    app.get('/fixture.js', (_req, res) => res.type('js').send(`
        window.calls = []; window.pending = {};
        window.Pivot = { legacy: {} };
        window.Pivot.legacy.PivotDataAnalysis = {
            API: '/api/analysis', state: { activeId: 'one', datasets: [{ id: 'one', name: '数据一' }, { id: 'two', name: '数据二' }], governanceDatasetId: '', assetsDatasetId: '', fieldGovernance: [], calculatedFields: [], savedViews: [] },
            esc: value => String(value || ''), fmtNumber: value => value, toast() {}, guardButton() {},
            updateToolbarHeader() {}, normalizeTab: value => value, persistActiveTab() {},
            loadSemanticModels() {}, loadScalability() {},
            fetchJson: url => { window.calls.push(url); return new Promise(resolve => { window.pending[url] = resolve; }); }
        };
    `));
    app.get('/', (_req, res) => res.send(`<!doctype html><meta charset="utf-8">
        <button class="data-analysis-tab active" data-data-analysis-tab="overview">总览</button>
        <button class="data-analysis-tab" data-data-analysis-tab="governance">字段治理</button>
        <button class="data-analysis-tab" data-data-analysis-tab="assets">分析资产</button>
        <div class="data-analysis-tab-panel" id="data-analysis-overview-panel"></div>
        <div class="data-analysis-tab-panel hidden" id="data-analysis-governance-panel"><select id="data-analysis-governance-dataset"></select><div id="data-analysis-field-governance"></div><div id="data-analysis-calculated-fields"></div><div id="data-analysis-source-state"></div></div>
        <div class="data-analysis-tab-panel hidden" id="data-analysis-assets-panel"><select id="data-analysis-assets-dataset"></select><div id="data-analysis-saved-views"></div></div>
        <script src="/common/vendor/purify.min.js"></script><script src="/fixture.js"></script><script src="/chat/safe-html.js"></script>
        <script src="/chat/data-analysis/governance.js"></script><script src="/chat/data-analysis/extensions.js"></script><script src="/chat/data-analysis/events.js"></script>`));
    const service = http.createServer(app);
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true, executablePath: require('../server/services/agent-browser').resolveChromiumExecutable(chromium) });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${service.address().port}/`);
        await page.evaluate(() => { const app = window.Pivot.legacy.PivotDataAnalysis; app.bindGovernanceEvents(document.body); app.activateTab('governance'); });
        const governance = page.locator('#data-analysis-governance-dataset');
        assert.equal(await governance.inputValue(), '');
        assert.equal(await governance.locator('option:checked').textContent(), '请选择数据集');
        assert.deepEqual(await page.evaluate(() => window.calls), []);
        await governance.selectOption('one');
        assert.equal((await page.evaluate(() => window.calls)).length, 3);
        await page.evaluate(() => window.Pivot.legacy.PivotDataAnalysis.activateTab('assets'));
        const assets = page.locator('#data-analysis-assets-dataset');
        assert.equal(await assets.inputValue(), '');
        assert.match(await page.locator('#data-analysis-saved-views').innerText(), /请选择关联数据集/);
        await assets.selectOption('two');
        await page.evaluate(() => window.pending['/api/analysis/views?datasetId=two']({ views: [{ id: 'v', name: '二号资产', viewType: 'chart' }] }));
        await page.getByText('二号资产').waitFor();
        await page.evaluate(() => window.Pivot.legacy.PivotDataAnalysis.activateTab('governance'));
        assert.equal(await governance.inputValue(), '');
        await page.evaluate(() => {
            for (const [url, resolve] of Object.entries(window.pending)) if (url.includes('/datasets/one/')) resolve(url.endsWith('/fields') ? { fields: [{ fieldKey: 'late', displayName: '迟到字段' }] } : { fields: [] });
        });
        await page.waitForTimeout(50);
        assert.doesNotMatch(await page.locator('#data-analysis-field-governance').innerText(), /迟到字段/);
        await page.evaluate(() => window.Pivot.legacy.PivotDataAnalysis.activateTab('assets'));
        assert.equal(await assets.inputValue(), '');
        assert.doesNotMatch(await page.locator('#data-analysis-saved-views').innerText(), /二号资产/);
        await governance.evaluate(() => window.Pivot.legacy.PivotDataAnalysis.activateTab('governance'));
        await governance.selectOption('two');
        await page.evaluate(() => {
            for (const [url, resolve] of Object.entries(window.pending)) if (url.includes('/datasets/two/')) resolve(url.endsWith('/fields') ? { fields: [{ fieldKey: 'field2', displayName: '有效字段' }] } : { fields: [] });
        });
        await page.locator('input[value="有效字段"]').waitFor();
        assert.equal(await governance.inputValue(), 'two');
    } finally {
        await browser?.close();
        service.closeAllConnections?.();
        await new Promise(resolve => service.close(resolve));
    }
});
