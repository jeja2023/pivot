'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const { createVoiceStreaming } = require('../server/services/speech-recognition/streaming');
const { readTypedEnv } = require('../server/config/env-registry');

function next(socket, event = 'message') {
    return Promise.race([once(socket, event), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('测试连接超时')), 3000); timer.unref(); })]);
}
async function setup({ embeddedMode = false } = {}) {
    const provider = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(provider, 'listening');
    const seen = [];
    provider.on('connection', (socket, req) => {
        assert.equal(req.headers.authorization, 'Bearer private-provider-key');
        socket.on('message', (data, binary) => {
            seen.push(binary ? { bytes: data.length } : JSON.parse(String(data)));
            if (!binary && JSON.parse(String(data)).type === 'end') {
                socket.send(JSON.stringify({ type: 'partial', text: '暂态错字' }));
                socket.send(JSON.stringify({ type: 'final', text: '句末修正结果', confidence: null }));
            }
        });
    });
    const env = { PIVOT_VOICE_PROVIDER: 'gateway', PIVOT_VOICE_ENDPOINT: `http://127.0.0.1:${provider.address().port}/transcribe`, PIVOT_VOICE_STREAM_ENDPOINT: `ws://127.0.0.1:${provider.address().port}/stream`,
        PIVOT_VOICE_API_KEY: 'private-provider-key', PIVOT_VOICE_HOTWORDS: '智枢,未成年人' };
    let authorized = true;
    const embedded = { async ensureReady() { return { endpoint: env.PIVOT_VOICE_ENDPOINT, streamEndpoint: env.PIVOT_VOICE_STREAM_ENDPOINT, apiKey: env.PIVOT_VOICE_API_KEY }; } };
    if (embeddedMode) { env.PIVOT_VOICE_PROVIDER = 'embedded'; env.PIVOT_EMBEDDED_VOICE_STARTUP_MS = '1000'; }
    const streaming = createVoiceStreaming({ read: name => readTypedEnv(name, env), embedded, checkEndpoint: async () => ({ internal: true }),
        authenticate: async () => { await new Promise(resolve => setImmediate(resolve)); return authorized ? { id: 7 } : null; } });
    const server = http.createServer(); const cleanup = streaming.attach(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const connect = async ticket => {
        const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/chat/voice-stream`);
        await once(socket, 'open'); const ready = next(socket); socket.send(JSON.stringify({ ticket })); return { socket, ready };
    };
    return { streaming, seen, connect, revoke() { authorized = false; }, async close() {
        cleanup(); for (const socket of provider.clients) socket.terminate(); await new Promise(resolve => provider.close(resolve)); await new Promise(resolve => server.close(resolve));
    } };
}

test('单次票据流式代理按序转发音频，暂态和句末修正分开返回且不外泄凭据', async () => {
    const app = await setup();
    try {
        const access = app.streaming.issueTicket({ id: 7 });
        assert.equal(access.path.includes(access.ticket), false);
        const { socket, ready } = await app.connect(access.ticket);
        assert.equal(JSON.parse(String((await ready)[0])).type, 'ready');
        const received = []; socket.on('message', data => received.push(JSON.parse(String(data))));
        socket.send('{"type":"begin"}'); socket.send(Buffer.alloc(6400)); socket.send('{"type":"end"}');
        for (let i = 0; i < 20 && received.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepEqual(received.map(event => event.type), ['partial', 'final']);
        assert.equal(received[1].text, '句末修正结果');
        assert.deepEqual(app.seen[0].hotwords, ['智枢', '未成年人']);
        assert.equal(app.seen[1].bytes, 6400);
        assert.equal(JSON.stringify(received).includes('private-provider-key'), false);
        socket.close(); await once(socket, 'close');
    } finally { await app.close(); }
});

test('内置语音复用单次票据流式代理，连接成功后清理模型启动计时器', async () => {
    const app = await setup({ embeddedMode: true });
    try {
        const access = app.streaming.issueTicket({ id: 7 });
        const { socket, ready } = await app.connect(access.ticket);
        assert.equal(JSON.parse(String((await ready)[0])).type, 'ready');
        await new Promise(resolve => setTimeout(resolve, 1100));
        assert.equal(socket.readyState, WebSocket.OPEN);
        const received = []; socket.on('message', data => received.push(JSON.parse(String(data))));
        socket.send('{"type":"begin"}'); socket.send(Buffer.alloc(6400)); socket.send('{"type":"end"}');
        for (let i = 0; i < 30 && received.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepEqual(received.map(event => event.type), ['partial', 'final']);
        socket.close(); await once(socket, 'close');
    } finally { await app.close(); }
});

test('语音票据只可用一次，账号撤销和无 begin 音频均终止连接', async () => {
    const app = await setup();
    try {
        const access = app.streaming.issueTicket({ id: 7 });
        const first = await app.connect(access.ticket); await first.ready;
        const duplicate = await app.connect(access.ticket);
        await next(duplicate.socket, 'close');
        app.revoke(); const closed = next(first.socket, 'close'); first.socket.send('{"type":"begin"}'); await closed;
    } finally { await app.close(); }
});
