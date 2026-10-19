const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function source() {
    let api;
    const urls = [];
    const context = { API_BASE: '/api', apiFetch: async url => {
        urls.push(url);
        return { ok: true, json: async () => url.includes('?') ? { data: [] } : { run: { id: url.split('/').at(-1) }, dagNodes: [] } };
    }, Pivot: { exposeModule(_name, value) { api = value; } } };
    context.window = context;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/dag-timeline-source.js'), 'utf8'), context);
    return { api, urls };
}

test('发布版快照与当前草稿不一致时不把旧版耗时绑定到当前画布', async () => {
    const { api, urls } = source();
    const draft = { nodes: [{ id: 'node', tool: 'workflow.template', input: { template: '新草稿' } }] };
    const published = { nodes: [{ id: 'node', tool: 'workflow.template', input: { template: '旧发布版' } }] };
    api.rememberRun({ id: 'published-run', metadata: { dagSpec: published } }, { spec: draft, workflowId: '1' });
    const current = await api.createSource({ spec: draft, workflowId: '1' })();
    assert.equal(current.run, null);
    assert.equal(urls.some(url => url.endsWith('published-run')), false);
    const actual = await api.createSource({ spec: published, workflowId: '1' })();
    assert.equal(actual.run.id, 'published-run');
});

test('同一画布的新运行替换旧运行后，已打开的瀑布图数据源会跟随新绑定', async () => {
    const { api } = source();
    const spec = { nodes: [{ id: 'node', tool: 'workflow.template' }] };
    api.rememberRun({ id: 'first' }, { spec, workflowId: '1' });
    const load = api.createSource({ spec, workflowId: '1' });
    assert.equal((await load()).run.id, 'first');
    api.rememberRun({ id: 'second' }, { spec, workflowId: '1' });
    assert.equal((await load()).run.id, 'second');
});
