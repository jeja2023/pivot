'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(request) {
    let api; let userId = 1; let payload = { name: '当前草稿', specText: '{"nodes":[]}' };
    const storage = new Map(); const offers = []; const events = new Map(); const statuses = [];
    const bridge = { request, capture: () => ({ ...payload }), restore: value => { payload = { ...value }; }, readOnly: () => false };
    const experience = { saveStatus: text => statuses.push(text), offerRecovery: (value, restore) => offers.push({ value, restore }), compareDraft: (_local, _remote, restore) => offers.push({ restore }) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/workflow-draft-store.js'), 'utf8'), {
        setTimeout: () => 1, clearTimeout() {}, addEventListener: (name, listener) => events.set(name, listener),
        localStorage: { get length() { return storage.size; }, key: index => [...storage.keys()][index], getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        window: { Pivot: { legacy: {}, moduleApi: name => name === 'agent.workflowExperience' ? experience : { userId: () => userId }, registerModule: (_name, value) => { api = value; } } }
    });
    return { api, bridge, storage, offers, events, statuses, setUser: value => { userId = value; }, edit: name => { payload.name = name; api.changed(); }, payload: () => payload };
}
const response = data => ({ ok: true, json: async () => data });

test('没有当前账号草稿时不会回退读取其他账号，未登录时不读取或列出本机草稿', async () => {
    let reads = 0;
    const h = harness(async () => { reads += 1; return response({ draft: null }); });
    h.storage.set('pivot.workflow.draft.2.shared-key', JSON.stringify({ name: '其他账号的内容', specText: '{"nodes":[]}', pending: true }));
    await h.api.load('shared-key', h.bridge);
    assert.equal(h.offers.length, 0);
    assert.equal(h.api.listLocal().length, 0);
    h.setUser('');
    await h.api.load('shared-key', h.bridge);
    assert.equal(reads, 1);
    assert.equal(h.api.listLocal().length, 0);
    assert.equal(h.api.current(), null);
});

test('保存响应晚于账号切换时不能把旧账号内容写入新账号，也不能显示为当前草稿', async () => {
    let complete;
    const h = harness(async (_url, options) => options ? new Promise(resolve => { complete = resolve; }) : response({ draft: null }));
    await h.api.load('workflow', h.bridge); h.edit('账号一的修改');
    const saving = h.api.flush();
    const event = { preventDefault() { this.prevented = true; } };
    h.events.get('beforeunload')(event);
    assert.equal(event.prevented, true);
    h.setUser(2);
    complete(response({ draft: { revision: 1 } })); await saving;
    assert.equal(h.api.current(), null);
    assert.equal(h.storage.has('pivot.workflow.draft.2.workflow'), false);
    assert.match(h.storage.get('pivot.workflow.draft.1.workflow'), /账号一的修改/);
    assert.equal(h.api.isSaved(), false);
});

test('恢复提示在切换账号后失效，单条损坏的本机草稿不阻断其他草稿', async () => {
    const h = harness(async () => { throw new Error('网络暂时不可用'); });
    h.storage.set('pivot.workflow.draft.1.workflow', JSON.stringify({ name: '本机内容', specText: '{"nodes":[]}' }));
    h.storage.set('pivot.workflow.draft.1.broken', '{');
    h.storage.set('pivot.workflow.draft.1.other', JSON.stringify({ name: '另一草稿', specText: '{"nodes":[{}]}' }));
    await h.api.load('workflow', h.bridge);
    assert.equal(h.api.listLocal().length, 2);
    h.setUser(2); h.offers[0].restore();
    assert.equal(h.payload().name, '当前草稿');
});
