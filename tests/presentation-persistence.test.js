'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(requestJson) {
    let module;
    const timers = new Map(); let next = 0;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/apps-workbench-presentations-persistence.js'), 'utf8'), {
        clearTimeout: id => timers.delete(id), window: { setTimeout: callback => { timers.set(++next, callback); return next; }, Pivot: { exposeModule: (_name, value) => { module = value; } } }
    });
    const state = { active: { id: 'one', version: 1, content: { title: '原稿' } }, documents: [{ id: 'one' }], editRevision: 0, dirty: false };
    const messages = [];
    const api = module.create(state, { requestJson, canEdit: () => true, setSaveState: text => messages.push(text), renderIssues() {}, toast: text => messages.push(text) });
    return { state, api, messages, timers };
}

test('离开前等待在途保存并继续保存其间的新修改，不把旧快照标为最新', async () => {
    const pending = deferred(); const writes = [];
    const h = harness(async (_url, options) => {
        const body = JSON.parse(options.body); writes.push(body);
        return writes.length === 1 ? pending.promise : { presentation: { id: 'one', version: 3, content: body.content } };
    });
    h.state.active.content.title = '第一稿'; h.api.scheduleSave();
    const first = h.api.saveActive();
    await Promise.resolve();
    h.state.active.content.title = '第二稿'; h.api.scheduleSave();
    let left = false;
    const leaving = h.api.flush().then(result => { left = result; });
    assert.equal(left, false);
    pending.resolve({ presentation: { id: 'one', version: 2, content: { title: '第一稿' } } });
    await first; await leaving;
    assert.deepEqual(writes.map(body => [body.baseVersion, body.content.title]), [[1, '第一稿'], [2, '第二稿']]);
    assert.equal(h.state.active.content.title, '第二稿');
    assert.equal(h.state.dirty, false);
    assert.equal(left, true);
});

test('保存失败或冲突阻止离开，保留当前正文并提示重试', async () => {
    for (const status of [500, 409]) {
        const h = harness(async () => { throw Object.assign(new Error('保存失败'), { status }); });
        h.state.active.content.title = '尚未保存'; h.api.scheduleSave();
        await assert.rejects(h.api.flush(), /保存失败/);
        assert.equal(h.state.active.content.title, '尚未保存');
        assert.equal(h.state.dirty, true);
        assert.equal(h.state.saving, false);
        assert.equal(h.state.savePromise, null);
        assert.equal(h.state.remoteVersionAvailable, status === 409);
    }
});

test('旧编辑会话的保存响应不能覆盖重新打开的同一文稿', async () => {
    const pending = deferred();
    const h = harness(() => pending.promise);
    h.api.scheduleSave(); const saving = h.api.saveActive();
    await Promise.resolve();
    h.api.invalidate(); h.state.active = { id: 'one', version: 7, content: { title: '重新打开' } };
    pending.resolve({ presentation: { id: 'one', version: 2, content: { title: '旧正文' } } });
    assert.equal(await saving, false);
    assert.equal(h.state.active.version, 7);
    assert.equal(h.state.active.content.title, '重新打开');
});

test('缺失保存确认时保留修改，未保存或在途保存时提示关闭风险', async () => {
    const h = harness(async () => ({}));
    h.api.scheduleSave();
    await assert.rejects(h.api.flush(), /有效的保存确认/);
    const event = { preventDefault() { this.prevented = true; } };
    h.api.beforeUnload(event);
    assert.equal(event.prevented, true);
    assert.equal(h.state.dirty, true);
});
