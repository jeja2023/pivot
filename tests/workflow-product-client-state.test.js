const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const definition = require('../client/chat/dag-definition');
const core = require('../client/chat/dag-core');
const { createHistory } = require('../client/chat/dag-editor-history');
const source = name => fs.readFileSync(require('node:path').resolve(__dirname, '../client/chat', name), 'utf8');
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function draftsHarness(request) {
    let api; let payload = { name: '当前草稿', specText: '{"nodes":[]}' };
    const storage = new Map(); const states = []; const offers = [];
    const experience = { saveStatus: text => states.push(text), offerRecovery: (value, restore) => offers.push({ value, restore }) };
    const bridge = { request, capture: () => ({ ...payload }), restore: value => { payload = { ...value }; }, readOnly: () => false };
    vm.runInNewContext(source('workflow-draft-store.js'), { console, setTimeout: () => 1, clearTimeout() {}, addEventListener() {},
        localStorage: { setItem: (key, value) => storage.set(key, value), getItem: key => storage.get(key) },
        window: { Pivot: { legacy: { currentUser: { id: 1 } }, moduleApi: name => name === 'agent.workflowExperience' ? experience : { userId: () => 1 }, registerModule: (_name, value) => { api = value; } } }
    });
    return { api: () => api, bridge, states, storage, offers, edit: name => { payload.name = name; api.changed(); }, payload: () => payload };
}

test('自动保存期间继续输入会串行合并，旧响应不能提前显示最新草稿已保存', async () => {
    const pending = deferred(); const writes = [];
    const current = draftsHarness(async (_path, options) => {
        if (!options) return response({ draft: { revision: 1, spec_text: '{"nodes":[]}', name: '当前草稿', updated_at: new Date().toISOString() } });
        writes.push(JSON.parse(options.body));
        return writes.length === 1 ? pending.promise : response({ draft: { revision: 3 } });
    });
    await current.api().load('workflow-1', current.bridge);
    current.edit('第一轮'); const first = current.api().flush();
    assert.equal(current.api().isSaved(), false);
    current.edit('第二轮'); const second = current.api().flush();
    pending.resolve(response({ draft: { revision: 2 } })); await Promise.all([first, second]);
    assert.deepEqual(writes.map(item => [item.name, item.expectedRevision]), [['第一轮', 1], ['第二轮', 2]]);
    assert.equal(current.api().isSaved(), true);
    assert.equal(current.states.at(-1), '草稿已保存');
});

test('读取尚未完成时编辑会等待修订号，冲突保留本机内容且阻止重试覆盖', async () => {
    const loaded = deferred(); const writes = [];
    const current = draftsHarness(async (_path, options) => {
        if (!options) return loaded.promise;
        writes.push(JSON.parse(options.body)); return response({ error: '另一窗口已更新' }, 409);
    });
    const loading = current.api().load('workflow-1', current.bridge); current.edit('加载期间的编辑');
    const saving = current.api().flush();
    loaded.resolve(response({ draft: { revision: 8, spec_text: '{}', name: '服务器草稿', updated_at: new Date().toISOString() } }));
    await loading; await saving;
    assert.equal(writes[0].expectedRevision, 8);
    assert.equal(current.payload().name, '加载期间的编辑');
    assert.equal(current.api().current().blocked, true);
    await current.api().flush(); assert.equal(writes.length, 1);
    assert.equal(JSON.parse(current.storage.get('pivot.workflow.draft.1.workflow-1')).name, '加载期间的编辑');
});

test('较新的离线副本可恢复，旧页面保存响应不会覆盖另一流程状态', async () => {
    const pending = deferred();
    const current = draftsHarness(async (path, options) => {
        if (options) return pending.promise;
        return response({ draft: { revision: 1, spec_text: '{"nodes":[]}', name: '服务器草稿', updated_at: new Date(Date.now() - 5000).toISOString() } });
    });
    current.storage.set('pivot.workflow.draft.1.first', JSON.stringify({ name: '本机新内容', specText: '{"nodes":[]}', savedAt: Date.now(), pending: true, revision: 1 }));
    await current.api().load('first', current.bridge); assert.equal(current.offers[0].value.name, '本机新内容');
    current.offers[0].restore(); assert.equal(current.payload().name, '本机新内容');
    const saving = current.api().flush();
    await current.api().load('second', current.bridge);
    const lastState = current.states.at(-1); pending.resolve(response({ draft: { revision: 2 } })); await saving;
    assert.equal(current.api().current().key, 'second'); assert.equal(current.states.at(-1), lastState);
});

test('编辑历史支持草稿快照撤销与重做', () => {
    let spec = { nodes: [{ id: 'a' }, { id: 'b', dependsOn: ['a'], input: { value: '{{?nodes.a.output.text ?? "备用"}}' }, when: { source: 'nodes.a.output.flag' } }], edges: [{ from: 'a', to: 'b', route: 'true' }] };
    const original = JSON.stringify(spec);
    const history = createHistory({ snapshot: () => JSON.stringify(spec), restore: value => { spec = JSON.parse(value); } });
    history.record();
    spec.nodes.push({ id: 'middle', input: {} });
    spec.nodes[1].dependsOn = ['middle'];
    history.undo();
    assert.equal(JSON.stringify(spec), original);
    history.redo();
    assert.equal(spec.nodes.length, 3);
});

test('更换上游测试或覆盖样本会使下游与在途请求失效，保留无关支线', () => {
    core.resetDagNodeTestSession();
    const spec = { nodes: [{ id: 'a', tool: 'workflow.template' }, { id: 'b', tool: 'workflow.template', dependsOn: ['a'] }, { id: 'other', tool: 'workflow.template' }] };
    core.setDagNodeTestContext(spec); core.setDagNodeTestOutput('a', { output: { text: 'old' } }); core.setDagNodeTestOutput('other', { output: 0 });
    const ticket = core.beginDagNodeTest('b', spec); core.setDagNodeTestOutput('b', { output: false });
    core.setDagNodeTestOutput('a', { output: { text: 'new' }, source: 'mock' });
    assert.equal(core.isDagNodeTestCurrent('b', ticket, spec), false);
    assert.deepEqual([...core.getNodeTestOutputSnapshots().keys()], ['a', 'other']);
    core.setDagNodeTestOutput('b', { output: 0 }); core.setDagNodeTestOverride('a', { text: 'override' });
    assert.equal(core.getNodeTestOutputSnapshots().has('b'), false);
});

test('历史结果复用核对定义与真实输入，表格和文件输出优先按内容呈现', () => {
    let api;
    vm.runInNewContext(source('workflow-product-results.js'), { URL, location: { href: 'https://pivot.test/chat' },
        window: { Pivot: { legacy: { PivotSafeHtml: { escapeHtml: text => String(text).replaceAll('<', '&lt;') }, renderMarkdown: text => text }, moduleApi: name => name === 'agent.dagDefinition' ? definition : core, registerModule: (_name, value) => { api = value; } } }
    });
    const spec = { nodes: [{ id: 'a', tool: 'workflow.output', input: { name: 'result', value: '{{inputs.flag}}' } }] };
    const run = { metadata: { dagSpec: spec, dagInputs: { flag: false, amount: 0 } } };
    assert.equal(api.reuseIssue(run, { ...spec, layout: { a: { x: 100 } } }, { amount: 0, flag: false }), '');
    assert.match(api.reuseIssue(run, spec, { amount: 0, flag: true }), /输入不同/);
    assert.match(api.valueHtml({ name: 'table', format: 'json', presentation: 'table', table: { rows: [{ 数量: 0, 通过: false }] } }), /<td>0<\/td>.*<td>false<\/td>/);
    assert.doesNotMatch(api.valueHtml({ presentation: 'file', file: { name: '文件', url: 'javascript:alert(1)' } }), /href/);
});
