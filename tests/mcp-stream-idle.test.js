'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { readMcpStreamResponse, drainMcpResponse } = require('../server/services/mcp-transport');
const { callMcpJsonRpc } = require('../server/services/mcp-client');

test('MCP silent response times out and closes the stream', async () => {
    const stream = new PassThrough();
    const pending = readMcpStreamResponse({ data: stream }, '1', { idleTimeoutMs: 1000 });
    await assert.rejects(pending, { code: 'MCP_STREAM_IDLE_TIMEOUT' });
    assert.equal(stream.destroyed, true);
});

test('MCP heartbeats keep a slow stream alive and keepAlive survives its result', async () => {
    const stream = new PassThrough();
    const notifications = [];
    const pending = readMcpStreamResponse({ data: stream }, '1', { idleTimeoutMs: 1000, keepAlive: true, onNotification: item => notifications.push(item) });
    const interval = setInterval(() => stream.write(': heartbeat\n\n'), 250);
    try {
        await new Promise(resolve => setTimeout(resolve, 1250));
        stream.write('data: {"jsonrpc":"2.0","id":"1","result":{}}\n\n');
        assert.equal((await pending).id, '1');
        clearInterval(interval);
        await new Promise(resolve => setTimeout(resolve, 1100));
        assert.equal(stream.destroyed, false);
        stream.write('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n');
        assert.equal(notifications.length, 1);
    } finally { clearInterval(interval); stream.destroy(); }
});

test('MCP cancellation and premature close settle the request', async () => {
    const controller = new AbortController();
    const stream = new PassThrough();
    const pending = readMcpStreamResponse({ data: stream }, '1', { signal: controller.signal, idleTimeoutMs: 1000 });
    controller.abort(new Error('请求已取消'));
    await assert.rejects(pending, /请求已取消/);
    assert.equal(stream.destroyed, true);
    const closed = new PassThrough();
    const closePending = readMcpStreamResponse({ data: closed }, '1', { idleTimeoutMs: 1000 });
    closed.destroy();
    await assert.rejects(closePending, /关闭/);
});

test('MCP stream can reconnect and preserve the last event ID', async () => {
    const stream = new PassThrough();
    let reconnectInfo;
    const pending = readMcpStreamResponse({ data: stream }, '1', {
        idleTimeoutMs: 1000,
        onReconnect: async info => { reconnectInfo = info; return { jsonrpc: '2.0', id: '1', result: {} }; }
    });
    stream.end('id: event-7\nretry: 10\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n');
    assert.equal((await pending).id, '1');
    assert.deepEqual(reconnectInfo, { lastEventId: 'event-7', retryMs: 10 });
});

test('MCP notification response drain times out and closes a silent stream', async () => {
    const stream = new PassThrough();
    await assert.rejects(drainMcpResponse({ data: stream }, { idleTimeoutMs: 1000 }), { code: 'MCP_STREAM_IDLE_TIMEOUT' });
    assert.equal(stream.destroyed, true);
});

test('HTTP MCP client applies the configured stream idle limit after headers', async () => {
    let closed = false;
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.flushHeaders();
            res.once('close', () => { closed = true; });
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const target = {
            id: `idle-${server.address().port}`,
            base_url: `http://127.0.0.1:${server.address().port}`,
            config: JSON.stringify({ protocolMode: 'standard', protocolVersion: '2026-07-28', streamIdleTimeoutMs: 1000 })
        };
        await assert.rejects(callMcpJsonRpc(target, 'tools/list', {}, { id: 1, role: 'admin' }), { code: 'MCP_STREAM_IDLE_TIMEOUT' });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(closed, true);
    } finally {
        server.closeAllConnections();
        if (server.listening) await new Promise(resolve => server.close(resolve));
    }
});
