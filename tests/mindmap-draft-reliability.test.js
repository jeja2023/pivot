'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
    let api; const opens = []; const transactions = []; const timers = new Map(); let sequence = 0;
    const db = { closed: false, close() { this.closed = true; }, transaction() {
        const transaction = { objectStore: () => ({ get: () => ({ result: { document: { tree: '草稿' } } }) }) };
        transactions.push(transaction); return transaction;
    } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/mindmaps/drafts.js'), 'utf8'), {
        location: { origin: 'https://pivot.test' }, setTimeout: callback => { timers.set(++sequence, callback); return sequence; }, clearTimeout: id => timers.delete(id),
        window: { indexedDB: { open() { const request = { result: db }; opens.push(request); return request; } }, Pivot: { exposeModule: (_name, value) => { api = value; } } }
    });
    return { api, opens, transactions, timers, db };
}

test('本地草稿数据库被旧窗口阻塞时明确失败，下一次读取可重新打开', async () => {
    const h = harness(); const blocked = h.api.read(1, 'one');
    const rejected = assert.rejects(blocked, /关闭其他旧页面/);
    h.opens[0].onblocked(); await rejected;
    h.opens[0].onsuccess(); assert.equal(h.db.closed, true);
    h.db.closed = false;
    const reading = h.api.read(1, 'one'); h.opens[1].onsuccess();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    h.transactions[0].oncomplete();
    assert.equal((await reading).document.tree, '草稿');
    assert.equal(h.timers.size, 0);
});

test('IndexedDB 事务中止会及时结束读取，数据库升级释放旧连接', async () => {
    const h = harness(); const reading = h.api.read(1, 'one');
    const rejected = assert.rejects(reading, /操作中断/);
    h.opens[0].onsuccess();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    h.transactions[0].onabort(); await rejected;
    h.db.onversionchange(); assert.equal(h.db.closed, true);
    const next = h.api.read(1, 'two'); const failed = assert.rejects(next, /本地草稿暂时不可用/);
    h.opens[1].onerror(); await failed;
});
