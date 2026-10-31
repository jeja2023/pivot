'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { startDurableEventFeed } = require('../server/services/realtime-durable-feed');
const { createEventsRouter } = require('../server/routes/events');

test('通知在查询期间到达时立即补查，停止后不再调度', async t => {
    const response = new EventEmitter();
    response.destroy = () => response.emit('close');
    let wake;
    let unsubscribed = false;
    const wakeup = { subscribe(_user, fn) { wake = fn; return () => { unsubscribed = true; }; } };
    const subscription = () => {};
    subscription.isActive = () => true;
    subscription.writeReplay = () => {};
    subscription.waitForDrain = async () => true;
    let release;
    let notify;
    const ready = new Promise(resolve => { notify = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const database = { async query() { calls += 1; if (calls === 1) { notify(); await gate; } return []; } };
    const stop = startDurableEventFeed({ userId: 1, after: '0', subscription, database, response, wakeup, intervalMs: 30000 });
    t.after(() => { release(); stop(); });
    await ready;
    wake(); wake();
    release();
    const deadline = Date.now() + 2000;
    while (calls < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 2);
    stop();
    assert.equal(unsubscribed, true);
    wake();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 2);
});

test('同一用户和游标的并发连接共享查询，不同用户或游标独立查询', async t => {
    const calls = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const database = { async query(_sql, args) { calls.push(args); await gate; return []; } };
    const stops = [];
    const open = (userId, after) => {
        const response = new EventEmitter();
        response.destroy = () => response.emit('close');
        const subscription = () => {};
        subscription.isActive = () => true;
        subscription.writeReplay = () => {};
        subscription.waitForDrain = async () => true;
        stops.push(startDurableEventFeed({ userId, after, subscription, database, response }));
    };
    t.after(() => { release(); stops.forEach(stop => stop()); });
    open(1, '10'); open(1, '10'); open(1, '9'); open(2, '10');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [[1, '10'], [1, '9'], [2, '10']]);
    release();
    await new Promise(resolve => setImmediate(resolve));
});

test('持久事件补查按用户和游标有序读取，失败断开连接供重放', async t => {
    const response = new EventEmitter();
    response.destroy = () => { response.destroyed = true; response.emit('close'); };
    const emitted = [];
    let active = true;
    const subscription = () => { active = false; };
    subscription.isActive = () => active;
    subscription.writeReplay = row => emitted.push(row.id);
    subscription.waitForDrain = async () => true;
    let calls = 0;
    const database = { async query(_sql, args) {
        assert.equal(args[0], 71);
        calls += 1;
        if (calls === 1) { assert.equal(args[1], '10'); return [{ id: '11' }, { id: '12' }]; }
        if (calls === 2) { assert.equal(args[1], '12'); return [{ id: '13' }]; }
        throw new Error('模拟数据库连接断开');
    } };
    const done = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('补查未及时完成')), 2000);
        response.once('close', () => { clearTimeout(timeout); resolve(); });
    });
    const stop = startDurableEventFeed({ userId: 71, after: '10', subscription, database, response, intervalMs: 10 });
    t.after(stop);
    await done;
    assert.deepEqual(emitted, ['11', '12', '13']);
    assert.equal(response.destroyed, true);
});

test('单批数据过大时按实际送达游标继续补查', async t => {
    const response = new EventEmitter();
    response.destroy = () => response.emit('close');
    const emitted = [];
    let active = true;
    const subscription = () => { active = false; };
    subscription.isActive = () => active;
    subscription.writeReplay = row => emitted.push(row.id);
    subscription.waitForDrain = async () => true;
    let calls = 0;
    const database = { async query(_sql, args) {
        calls += 1;
        if (calls === 1) return [{ id: '1', payload: 'x'.repeat(60) }, { id: '2', payload: 'y'.repeat(60) }];
        assert.equal(args[1], '1');
        return [{ id: '2', payload: 'y'.repeat(60) }];
    } };
    const keepAlive = setTimeout(() => {}, 2000);
    const stop = startDurableEventFeed({ userId: 1, after: '0', subscription, database, response, intervalMs: 1000, maxBufferedBytes: 100 });
    t.after(() => { clearTimeout(keepAlive); stop(); });
    const deadline = Date.now() + 2000;
    while (emitted.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    stop();
    assert.deepEqual(emitted, ['1', '2']);
});

test('空库连接先保存零游标，断线后不会跳过新提交的首个事件', async () => {
    let inserted = false;
    const database = { async query(sql, args) {
        if (sql.includes('MAX(id)')) return [{ max_id: inserted ? '1' : '0' }];
        return inserted && args[1] === '0' ? [{ id: '1', run_id: 'run', event_seq: 1, event_type: 'run.progress', payload: {} }] : [];
    } };
    const app = express();
    app.use(createEventsRouter({ durableEvents: true, database, authMiddleware(req, _res, next) { req.user = { id: 1 }; next(); } }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const read = (after, target) => new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/events', headers: after === undefined ? {} : { 'Last-Event-ID': after } }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk.toString(); if (data.includes(target)) { resolve(data); res.destroy(); } });
            res.on('error', reject);
        });
        req.setTimeout(5000, () => req.destroy(new Error('等待事件超时')));
        req.on('error', reject);
    });
    try {
        assert.match(await read(undefined, 'event: connected'), /^id: 0\n/m);
        inserted = true;
        const replay = await read('0', 'event: agent.event');
        assert.match(replay, /^id: 1\n/m);
    } finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
});
