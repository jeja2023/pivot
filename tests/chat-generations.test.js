'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function fixture() {
    const modules = {};
    const hidden = new Map();
    let mounts = 0;
    const container = { appendChild() { mounts++; }, querySelectorAll: () => [] };
    const legacy = { currentUser: { id: 1 }, currentSessionId: 'a' };
    const window = { Pivot: { legacy, moduleApi: name => modules[name] || {}, exposeModule: (name, value) => { modules[name] = value; } }, addEventListener() {} };
    const context = { window, document: { getElementById: id => id === 'message-container' ? container : ({ classList: { toggle: (_name, value) => hidden.set(id, value) } }) } };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../client/chat/chat-generations.js'), 'utf8'), context);
    return { api: modules['chat.generations'], legacy, hidden, mounts: () => mounts };
}
function latch() { let release; return { promise: new Promise(resolve => { release = resolve; }), release: () => release() }; }

test('不同会话同时生成，切换不会取消原请求，后台完成不清除当前停止按钮', async () => {
    const { api, legacy, hidden } = fixture();
    const a = new AbortController(), b = new AbortController();
    const first = latch(), second = latch();
    const runA = api.run(async entry => { api.bind(entry, { controller: a }); await first.promise; });
    api.stopVoiceRequest('');
    assert.equal(a.signal.aborted, false);
    legacy.currentSessionId = 'b'; api.syncControls();
    assert.equal(hidden.get('stop-btn'), true);
    assert.equal(a.signal.aborted, false);
    const runB = api.run(async entry => { api.bind(entry, { controller: b }); await second.promise; });
    assert.equal(api.controller(), b);
    first.release(); await runA;
    assert.equal(hidden.get('stop-btn'), false);
    assert.equal(hidden.get('send-btn'), true);
    assert.equal(b.signal.aborted, false);
    api.controller().abort();
    assert.equal(b.signal.aborted, true);
    second.release(); await runB;
    assert.equal(api.busy(), false);
});

test('同一会话发送会串行替换旧请求，账号切换或删除不会恢复旧内容', async () => {
    const { api, legacy } = fixture();
    const old = new AbortController();
    let started = false;
    const first = api.run(async entry => {
        api.bind(entry, { controller: old });
        await new Promise(resolve => old.signal.addEventListener('abort', resolve, { once: true }));
    });
    const second = api.run(async entry => { started = true; assert.equal(old.signal.aborted, true); assert.equal(api.owned(entry), true); });
    await Promise.all([first, second]); assert.equal(started, true);
    const retained = new AbortController(); const wait = latch(); let saved;
    const pending = api.run(async entry => { saved = entry; api.bind(entry, { controller: retained }); await wait.promise; });
    legacy.currentUser = { id: 2 }; api.syncControls();
    assert.equal(api.owned(saved), false);
    assert.equal(api.controller(), null);
    api.clear(); assert.equal(retained.signal.aborted, true);
    wait.release(); await pending;
    const deleted = new AbortController(); const last = latch();
    const task = api.run(async entry => { api.bind(entry, { controller: deleted }); await last.promise; });
    api.discardSession('a'); assert.equal(deleted.signal.aborted, true);
    last.release(); await task;
});

test('历史先返回完整答案而保存通知尚未到达时，不再挂载第二个回复气泡', async () => {
    const { api, mounts } = fixture();
    const wait = latch();
    const content = id => ({ dataset: { ...(id ? { messageId: String(id) } : {}) }, closest: () => ({ dataset: {} }) });
    const task = api.run(async entry => { api.bind(entry, { user: content(10), assistant: content(), controller: new AbortController() }); await wait.promise; });
    api.restore('a', [{ id: 10, role: 'user' }, { id: 11, role: 'assistant', content: '已保存答案' }]);
    assert.equal(mounts(), 0);
    api.restore('a', [{ id: 10, role: 'user' }, { id: 20, role: 'user' }, { id: 21, role: 'assistant' }]);
    assert.equal(mounts(), 2, '其它用户消息之后的回答不能冒充当前生成的保存结果');
    wait.release(); await task;
});
