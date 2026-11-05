'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const turn = () => new Promise(resolve => setImmediate(resolve));
function harness() {
    const requests = []; const timers = new Map(); const listeners = new Map(); let next = 0;
    const elements = new Map();
    const document = { hidden: false, getElementById: id => elements.get(id) || null, querySelector: () => null,
        addEventListener: (name, handler) => listeners.set(name, handler) };
    const context = { document, console, encodeURIComponent, setTimeout: callback => { timers.set(++next, callback); return next; }, clearTimeout: id => timers.delete(id),
        FormData: class { append() {} },
        window: { sessionStorage: { getItem: () => null }, Pivot: { legacy: {} }, addEventListener: (name, handler) => listeners.set(name, handler) },
        apiFetch: (url, options) => { const pending = deferred(); requests.push({ url, options, resolve: data => pending.resolve({ ok: true, status: 200, json: async () => data }) }); return pending.promise; },
        PivotSafeHtml: { setHtml() {} }
    };
    const load = name => vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/data-analysis', name), 'utf8'), context);
    load('context.js');
    const app = context.window.Pivot.legacy.PivotDataAnalysis;
    for (const name of ['renderHeader', 'renderOverview', 'renderControls', 'renderChart', 'renderCompare', 'renderQueryFields', 'renderPivotControls']) app[name] = () => {};
    app.state.datasets = [{ id: 'a', name: '数据甲', columns: [] }, { id: 'b', name: '数据乙', columns: [] }];
    load('core.js');
    return { app, context, load, requests, timers, listeners, elements };
}

test('快速切换数据集时晚返回的详情和摘要不能恢复旧选择', async () => {
    const h = harness();
    const shown = { query: '旧查询结果', pivot: '旧透视结果' };
    h.app.state.query = { rows: ['旧查询结果'] }; h.app.state.pivot = { rows: ['旧透视结果'] };
    h.app.renderQuery = () => { shown.query = h.app.state.query ? '查询结果' : ''; };
    h.app.renderPivot = () => { shown.pivot = h.app.state.pivot ? '透视结果' : ''; };
    const first = h.app.loadDatasetDetail('a');
    const second = h.app.loadDatasetDetail('b');
    assert.equal(h.app.state.activeId, 'b');
    assert.equal(shown.query, ''); assert.equal(shown.pivot, '');
    h.requests[1].resolve({ dataset: { id: 'b', name: '数据乙', columns: [] } });
    await turn();
    h.requests[2].resolve({ summary: '乙摘要' }); await second;
    h.requests[0].resolve({ dataset: { id: 'a', name: '迟到数据甲', columns: [] } }); await first;
    assert.equal(h.app.state.activeId, 'b'); assert.equal(h.app.state.summary.summary, '乙摘要');
    assert.equal(h.requests.filter(request => request.url.endsWith('/a/summary')).length, 0);
});

test('查询中切换后再回到同一数据集，旧结果仍然失效；清空页签也会阻止迟到结果', async () => {
    const h = harness(); h.load('query.js');
    h.elements.set('data-analysis-query-sql', { value: 'SELECT * FROM data' });
    h.app.state.activeId = 'a';
    const first = h.app.runQuery();
    h.app.state.activeId = 'b'; h.app.state.datasetEpoch += 1;
    h.app.state.activeId = 'a'; h.app.state.datasetEpoch += 1;
    h.requests[0].resolve({ columns: ['旧结果'], rows: [{ 旧结果: '不应显示' }] }); await first;
    assert.equal(h.app.state.query, null);
    const second = h.app.runQuery();
    h.app.invalidateRequest('query');
    h.requests[1].resolve({ columns: ['已清空'], rows: [] }); await second;
    assert.equal(h.app.state.query, null);
});

test('后台查询轮询在响应后才安排下一轮，隐藏或离开时停止，迟到任务不会串到新数据集', async () => {
    const h = harness();
    h.elements.set('data-analysis-view', { closest: () => null });
    h.elements.set('data-analysis-query-panel', { classList: { contains: () => false } });
    h.load('async-query.js'); h.app.state.activeId = 'a';
    const first = h.app.loadAsyncQueryJobs();
    assert.equal(h.timers.size, 0);
    h.requests[0].resolve({ jobs: [{ id: 'one', status: 'running' }] }); await first;
    assert.equal(h.timers.size, 1);
    h.context.document.hidden = true; h.listeners.get('visibilitychange')();
    assert.equal(h.timers.size, 0);
    const old = h.app.loadAsyncQueryJobs();
    h.app.state.activeId = 'b'; h.app.stopAsyncQueryPolling(); h.app.state.asyncQueryJobs = [];
    h.requests[1].resolve({ jobs: [{ id: 'old', status: 'running' }] }); await old;
    assert.equal(h.app.state.asyncQueryJobs.length, 0); assert.equal(h.timers.size, 0);
});

test('表格导入请求使用与后台工作线程一致的有界期限，避免通用短期限提前中断', async () => {
    const h = harness();
    const importing = h.app.uploadDataset({ name: '大型工作簿.xlsx' });
    assert.equal(h.requests[0].options.timeoutMs, 300000);
    assert.equal(h.requests[0].options.method, 'POST');
    h.requests[0].resolve({ dataset: { id: '' } }); await turn();
    h.requests[1].resolve({ datasets: [] }); await importing;
});
