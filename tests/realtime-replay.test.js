'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { createEventsRouter } = require('../server/routes/events');
const { publishUserEvent, subscribeUserEvents } = require('../server/services/realtime-events');
const { createSseResponseWriter } = require('../server/services/sse-response');

test('重连按页补发所有事件并缓存查询期间的实时事件', async () => {
    let releasePage;
    let notifyPage;
    const waiting = new Promise(resolve => { notifyPage = resolve; });
    const pause = new Promise(resolve => { releasePage = resolve; });
    let pages = 0;
    const rows = Array.from({ length: 259 }, (_, index) => ({ id: String(index + 2), run_id: 'run', event_seq: index + 2, event_type: 'run.progress', payload: {} }));
    const queryFn = async (sql, params) => {
        assert.equal(params[0], 12345);
        if (sql.includes('MAX(id)')) return [{ max_id: '260' }];
        pages += 1;
        if (pages === 1) { notifyPage(); await pause; }
        return rows.filter(row => BigInt(row.id) > BigInt(params[1]) && BigInt(row.id) <= BigInt(params[2])).slice(0, 200);
    };
    const app = express();
    app.use(createEventsRouter({ authMiddleware(req, _res, next) { req.user = { id: 12345 }; next(); }, database: { query: queryFn } }));
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    try {
        const result = new Promise((resolve, reject) => {
            const request = http.get({ host: '127.0.0.1', port: server.address().port, path: '/events', headers: { 'Last-Event-ID': '1' } }, response => {
                let data = '';
                response.on('data', chunk => {
                    data += chunk.toString();
                    if (data.includes('id: 262\n')) { resolve(data); response.destroy(); }
                });
                response.on('error', reject);
            });
            request.setTimeout(5000, () => request.destroy(new Error('SSE replay timed out')));
            request.on('error', reject);
        });
        await waiting;
        for (const id of [262, 260, 261, 261]) publishUserEvent(12345, 'agent.event', { eventId: String(id), runId: 'run', eventSeq: id, eventType: 'run.progress', payload: {} });
        releasePage();
        const data = await result;
        const ids = [...data.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
        assert.deepEqual(ids, Array.from({ length: 261 }, (_, index) => index + 2));
        assert.equal(pages, 2);
    } finally { releasePage(); await new Promise(resolve => server.close(resolve)); }
});

test('补发期间实时事件缓存达到上限时关闭慢连接', () => {
    const response = new EventEmitter();
    response.setHeader = () => {};
    response.write = () => true;
    response.destroy = () => { response.destroyed = true; response.emit('close'); };
    const unsubscribe = subscribeUserEvents({ id: 12346 }, response, { heartbeatMs: 0, bufferAgentEvents: true });
    for (let i = 0; i <= 1000; i += 1) publishUserEvent(12346, 'agent.event', { eventId: String(i + 1) });
    assert.equal(response.destroyed, true);
    assert.equal(unsubscribe.isActive(), false);
    unsubscribe();
});

test('SSE 补发等待背压消退后才继续', async () => {
    const response = new EventEmitter();
    response.setHeader = () => {};
    response.writableNeedDrain = true;
    response.write = () => true;
    const writer = createSseResponseWriter(response, { heartbeatMs: 0 });
    writer.writeRaw('queued');
    let drained = false;
    const waiting = writer.waitForDrain().then(result => { drained = result; });
    await Promise.resolve();
    assert.equal(drained, false);
    response.writableNeedDrain = false;
    response.emit('drain');
    await waiting;
    assert.equal(drained, true);
    writer.cleanup();
});

test('持续背压超时后关闭连接并释放等待', async () => {
    const response = new EventEmitter();
    response.setHeader = () => {};
    response.writableNeedDrain = true;
    response.write = () => true;
    response.destroy = () => { response.destroyed = true; response.emit('close'); };
    const writer = createSseResponseWriter(response, { heartbeatMs: 0 });
    writer.writeRaw('queued');
    assert.equal(await writer.waitForDrain(20), false);
    assert.equal(response.destroyed, true);
    assert.equal(writer.isWritable(), false);
});

test('单次重放限制页数并保留可继续的已送达游标', async () => {
    let pages = 0;
    const app = express();
    app.use(createEventsRouter({
        authMiddleware(req, _res, next) { req.user = { id: 12347 }; next(); },
        database: { async query(sql, params) {
            if (sql.includes('MAX(id)')) return [{ max_id: '5201' }];
            pages += 1;
            return Array.from({ length: Math.min(200, 5201 - Number(params[1])) }, (_, index) => ({
                id: String(Number(params[1]) + index + 1), run_id: 'run', event_seq: index + 1, event_type: 'run.progress', payload: {}
            }));
        } }
    }));
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    try {
        const read = (cursor, stopAt = '') => new Promise((resolve, reject) => {
            const request = http.get({ host: '127.0.0.1', port: server.address().port, path: '/events', headers: { 'Last-Event-ID': cursor } }, response => {
                let body = '';
                response.on('data', chunk => {
                    body += chunk.toString();
                    if (stopAt && body.includes(`id: ${stopAt}\n`)) { resolve(body); response.destroy(); }
                });
                response.on('end', () => resolve(body));
                response.on('error', reject);
            });
            request.setTimeout(5000, () => request.destroy(new Error('SSE replay timed out')));
            request.on('error', reject);
        });
        const first = await read('1');
        assert.equal(pages, 25);
        const ids = [...first.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
        assert.equal(ids.length, 5000);
        assert.equal(ids.at(-1), 5001);
        const second = await read(String(ids.at(-1)), '5201');
        const continued = [...second.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
        assert.equal(continued[0], 5002);
        assert.equal(continued.at(-1), 5201);
        assert.equal(pages, 26);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
