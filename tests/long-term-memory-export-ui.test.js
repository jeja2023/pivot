'use strict';

const assert = require('node:assert/strict');
const { Blob } = require('node:buffer');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createUi(pages) {
    const notices = [];
    const requests = [];
    let savedBlob = null;
    let downloads = 0;
    const sandbox = {
        window: { Pivot: { legacy: {}, exposeModule: () => {} } },
        document: { getElementById: () => null, createElement: () => ({ click: () => { downloads++; } }) },
        pageState: { memories: 1, memoriesLimit: 20 }, API_BASE: '/api', URLSearchParams, Blob,
        URL: { createObjectURL: blob => { savedBlob = blob; return 'blob:test'; }, revokeObjectURL: () => {} },
        apiFetch: async url => { requests.push(url); return { ok: true, json: async () => ({ export: pages.shift() }) }; },
        showToast: (message, type) => notices.push({ message, type })
    };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../client/chat/admin-settings-memory.js'), 'utf8'), sandbox);
    return { run: () => sandbox.window.Pivot.legacy.exportMemories(), notices, requests,
        getBlob: () => savedBlob, getDownloads: () => downloads };
}

test('前端只接受服务端重复读一致性快照并提示安全导出', async () => {
    const ui = createUi([
        { startOffset: 0, total: 3, complete: true, nextOffset: null, consistency: 'repeatable_read_snapshot', memories: [{ id: 1 }, { id: 2 }, { id: 3 }] }
    ]);
    await ui.run();
    assert.equal(ui.getDownloads(), 1);
    const exported = JSON.parse(await ui.getBlob().text());
    assert.equal(exported.exportedCount, 3);
    assert.equal(exported.consistency, 'repeatable_read_snapshot');
    assert.match(ui.notices[0].message, /一致性快照/);
    assert.equal(ui.requests.length, 1);
    assert.match(ui.requests[0], /snapshot=true/);
});

test('前端拒绝截断、best-effort 或计数不一致的导出响应', async () => {
    for (const pages of [
        [{ startOffset: 0, total: 2, complete: false, consistency: 'repeatable_read_snapshot', memories: [{ id: 1 }] }],
        [{ startOffset: 0, total: 2, complete: true, consistency: 'best_effort', memories: [{ id: 1 }, { id: 2 }] }],
        [{ startOffset: 0, total: 3, complete: true, consistency: 'repeatable_read_snapshot', memories: [{ id: 1 }, { id: 2 }] }]
    ]) {
        const ui = createUi(pages);
        await ui.run();
        assert.equal(ui.getDownloads(), 0);
        assert.equal(ui.notices.at(-1).type, 'error');
        assert.equal(ui.requests.length, 1);
    }
});
