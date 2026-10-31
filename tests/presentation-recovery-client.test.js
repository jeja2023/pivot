'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('迟到的评论响应不会覆盖新文稿或更新的评论结果', async () => {
    const badge = { textContent: '', classList: { toggle() {} } };
    const pending = [];
    let api;
    const response = comments => ({ ok: true, clone() { return { json: async () => ({ comments }) }; } });
    const sandbox = {
        document: { getElementById: id => id === 'presentation-comments-badge' ? badge : null },
        apiFetch: async (url, options = {}) => {
            if (options.method === 'DELETE') return response([]);
            if (!url.endsWith('/comments')) return response([]);
            return await new Promise(resolve => pending.push({ url, resolve }));
        },
        clearInterval() {}, console,
        window: { addEventListener() {}, setInterval() { return 1; }, Pivot: {
            moduleApi: () => ({ isVisible: () => false }), exposeModule: (_name, value) => { api = value; }
        } }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/apps-workbench-presentations-collab.js'), 'utf8'), sandbox);
    api.startPresenceHeartbeat('first');
    const old = api.loadComments('first');
    api.startPresenceHeartbeat('second');
    const current = api.loadComments('second');
    pending[1].resolve(response([{ status: 'open' }]));
    await current;
    pending[0].resolve(response(Array.from({ length: 9 }, () => ({ status: 'open' }))));
    await old;
    assert.equal(badge.textContent, '1');
    const older = api.loadComments('second');
    const newer = api.loadComments('second');
    pending[3].resolve(response([{ status: 'open' }, { status: 'open' }]));
    await newer;
    pending[2].resolve(response([{ status: 'open' }]));
    await older;
    assert.equal(badge.textContent, '2');
    api.stopPresenceHeartbeat();
});

test('旧文稿迟到的撤权和更新响应不会改变当前文稿', async () => {
    let api;
    const sandbox = { window: { Pivot: { exposeModule: (_name, value) => { api = value; } } } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/apps-workbench-presentations-realtime.js'), 'utf8'), sandbox);
    const old = { id: 'one' };
    let active = old;
    let rejectOld;
    let revoked = 0;
    const pending = api.fetchCurrent({ active: old, getActive: () => active,
        request: () => new Promise((_resolve, reject) => { rejectOld = reject; }), onRevoked: () => { revoked += 1; } });
    active = { id: 'two' };
    rejectOld(Object.assign(new Error('已撤权'), { status: 404 }));
    await assert.rejects(pending, /已撤权/);
    assert.equal(revoked, 0);
    const current = active;
    await assert.rejects(api.fetchCurrent({ active: current, getActive: () => active,
        request: async () => { throw Object.assign(new Error('暂时失败'), { status: 500 }); }, onRevoked: () => { revoked += 1; } }), /暂时失败/);
    assert.equal(revoked, 0);
    await assert.rejects(api.fetchCurrent({ active: current, getActive: () => active,
        request: async () => { throw Object.assign(new Error('已撤权'), { status: 403 }); }, onRevoked: () => { revoked += 1; } }), /已撤权/);
    assert.equal(revoked, 1);
    let resolveOld;
    const oldData = api.fetchCurrent({ active: current, getActive: () => active,
        request: () => new Promise(resolve => { resolveOld = resolve; }), onRevoked() {} });
    active = { id: 'three' };
    resolveOld({ presentation: { id: 'two' } });
    assert.equal(await oldData, null);
});
