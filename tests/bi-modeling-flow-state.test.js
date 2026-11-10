'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function view(fetchJson) {
    const app = { state: { datasets: [] }, API: '/apps/data-analysis', fetchJson, esc: value => String(value ?? '') };
    const document = { hidden: false, getElementById() { return null; }, addEventListener() {} };
    const legacy = { PivotDataAnalysis: app, currentUser: { id: 1 } };
    const context = { window: { Pivot: { legacy }, crypto, addEventListener() {} }, document, setTimeout, clearTimeout, Event: globalThis.Event, URLSearchParams };
    for (const file of ['modeling-state.js', 'modeling-preview.js', 'modeling-operators.js', 'modeling.js']) vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../client/chat/data-analysis', file), 'utf8'), context);
    const m = app.modeling;
    m.render = () => {}; m.renderSaveState = () => {}; m.columns = () => [{ key: 'c_1', name: 'amount' }];
    Object.assign(m.state, { selected: { id: 'model', isOwner: true, lifecycle: 'draft', version: 2 }, draft: { nodes: [{ id: 'fact', datasetId: 'ds', role: 'fact' }] },
        flowGraph: { nodes: [{ id: 'filter', kind: 'filter', config: { conditions: [{ field: 'amount', operator: 'gt', value: '100' }] } }], edges: [{ id: 'e', fromNodeId: 'fact', toNodeId: 'filter' }] } });
    return { m, document, legacy };
}
function job(status, key = '', id = 'job') {
    return { id, executionKind: 'model_node_preview', status, node: { targetNodeId: 'filter', requestKey: key }, result: status === 'succeeded' ? { preview: { columns: [{ name: 'amount' }], rows: [{ amount: 150 }], totalRows: 1 } } : null };
}

test('配置变更拒绝迟到预览与字段缓存，旧任务状态仍可追踪', async () => {
    const result = deferred();
    let sent;
    const { m } = view((_url, options) => {
        if (options) { sent = JSON.parse(options.body); return Promise.resolve({ job: job('queued', sent.requestKey) }); }
        return result.promise;
    });
    const pending = m.runNodePreview('filter');
    await new Promise(resolve => setImmediate(resolve));
    m.state.flowGraph.nodes[0].config.conditions[0].value = '200';
    m.changed();
    result.resolve({ job: job('succeeded', sent.requestKey) });
    await pending;
    assert.equal(sent.flowGraph.nodes[0].config.conditions[0].value, '100');
    assert.equal(m.state.previewData, null);
    assert.equal(m.state.previewStale, true);
    assert.equal(m.state.schemaCache.filter, undefined);
    assert.equal(m.state.nodeJob.status, 'succeeded');
});

test('切回同一模型、账号切换和隐藏工作区均不接受上一编辑周期的预览', async () => {
    for (const action of ['reopen', 'account', 'hidden']) {
        const result = deferred();
        const { m, document, legacy } = view((_url, options) => options ? Promise.resolve({ job: job('queued') }) : result.promise);
        const pending = m.runNodePreview('filter');
        await new Promise(resolve => setImmediate(resolve));
        if (action === 'reopen') { m.reset(); m.state.selected = { id: 'model' }; }
        if (action === 'account') legacy.currentUser = { id: 2 };
        if (action === 'hidden') document.hidden = true;
        result.resolve({ job: job('succeeded') });
        await pending;
        assert.equal(m.state.previewData, null, action);
    }
});

test('请求丢失后重试复用幂等标识，成功后的主动刷新创建新任务', async () => {
    const keys = [];
    let fail = true;
    const { m } = view((_url, options) => {
        if (options) {
            keys.push(JSON.parse(options.body).requestKey);
            if (fail) { fail = false; throw new Error('模拟响应丢失'); }
            return Promise.resolve({ job: job('queued', keys.at(-1), `job_${keys.length}`) });
        }
        return Promise.resolve({ job: job('succeeded', keys.at(-1), `job_${keys.length}`) });
    });
    await assert.rejects(m.runNodePreview('filter'), /模拟响应丢失/);
    await m.runNodePreview('filter');
    await m.runNodePreview('filter');
    assert.equal(keys[0], keys[1]); assert.notEqual(keys[1], keys[2]);
    assert.equal(m.state.previewStale, false);
    assert.equal(m.state.previewData.rows[0].amount, 150);
});

test('上游字段变更清除下游推断缓存，空选择与聚合自动列名和执行器保持一致', () => {
    const { m } = view(() => {});
    Object.assign(m.state.flowGraph, { nodes: [{ id: 'formula', kind: 'formula', config: { fields: [{ name: 'new_amount', expression: '1' }] } },
        { id: 'tail', kind: 'filter', config: {} }, { id: 'agg', kind: 'aggregate', config: { aggregations: [{ field: 'amount', fn: 'sum', alias: '' }] } },
        { id: 'select', kind: 'select', config: { columns: [{ field: 'amount', enabled: false }] } }],
    edges: [{ fromNodeId: 'fact', toNodeId: 'formula' }, { fromNodeId: 'formula', toNodeId: 'tail' }] });
    m.state.schemaCache.tail = ['old_amount'];
    m.changed();
    assert.equal(m.inferNodeColumns('tail').includes('new_amount'), true);
    assert.equal(m.inferNodeColumns('tail').includes('old_amount'), false);
    assert.equal(m.inferNodeColumns('agg')[0], 'amount_求和');
    assert.equal(m.inferNodeColumns('select').length, 0);
});
