'use strict';
/* global window -- Chromium 页面执行上下文。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const { chromium } = require('@playwright/test');
const { createVoiceStreaming } = require('../server/services/speech-recognition/streaming');
const { readTypedEnv } = require('../server/config/env-registry');

test('真实 Chromium 与 WebSocket 代理贯通中文暂态、句末修正、停止与音频清理', async () => {
    const gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(gateway, 'listening');
    let audioBytes = 0;
    let finalCount = 0;
    gateway.on('connection', socket => {
        socket.on('message', (data, binary) => {
            if (binary) { audioBytes += data.length; return; }
            if (JSON.parse(String(data)).type === 'end') {
                finalCount++;
                socket.send(JSON.stringify({ type: 'partial', text: '刑罚第十七调' }));
                setTimeout(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'final', text: '刑法第十七条', confidence: null })); }, 100);
            }
        });
    });
    const env = { PIVOT_VOICE_PROVIDER: 'gateway', PIVOT_VOICE_ENDPOINT: `http://127.0.0.1:${gateway.address().port}/transcribe`,
        PIVOT_VOICE_STREAM_ENDPOINT: `ws://127.0.0.1:${gateway.address().port}/stream` };
    const streaming = createVoiceStreaming({ read: name => readTypedEnv(name, env), checkEndpoint: async () => ({ internal: true }), authenticate: async () => ({ id: 77 }) });
    const scriptFiles = new Set(['voice-audio.js', 'voice-speech-gate.js', 'voice-streaming-recognition.js']);
    const server = http.createServer((req, res) => {
        if (req.url === '/api/chat/voice-stream-tickets') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(streaming.issueTicket({ id: 77 }))); return; }
        if (req.url.startsWith('/chat/')) {
            const name = req.url.split('/chat/')[1];
            if (scriptFiles.has(name)) { res.setHeader('Content-Type', 'application/javascript'); res.end(fs.readFileSync(path.join(__dirname, '../client/chat', name))); return; }
        }
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'");
        res.end('<!DOCTYPE html><html><head></head><body>语音流式回归</body></html>');
    });
    const closeStreaming = streaming.attach(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.evaluate(() => {
            const modules = new Map();
            window.Pivot = { exposeModule: (name, api) => modules.set(name, api), moduleApi: name => modules.get(name) };
            window.API_BASE = '/api'; window.apiFetch = (...args) => fetch(...args);
            const node = () => ({ connect() {}, disconnect() {} });
            window.AudioContext = class {
                constructor() { this.sampleRate = 16000; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
                createMediaStreamSource() { return node(); }
                createGain() { return { ...node(), gain: {} }; }
                resume() { return Promise.resolve(); }
                close() { window.__closed++; return Promise.resolve(); }
            };
            window.AudioWorkletNode = class {
                constructor() { this.port = {}; window.__port = this.port; }
                connect() {} disconnect() {}
            };
            window.__events = []; window.__started = false; window.__ended = false; window.__closed = 0;
        });
        for (const name of scriptFiles) await page.addScriptTag({ url: `/chat/${name}` });
        await page.evaluate(() => {
            const recognition = window.Pivot.moduleApi('chat.voiceStreamingRecognition').create('zh-CN');
            recognition.continuous = true;
            recognition.attachStream({ getTracks: () => [{ stop() {} }] });
            recognition.onresult = event => window.__events.push(event.results.map(result => ({ final: result.isFinal, text: result[0].transcript })));
            recognition.onstart = () => { window.__started = true; };
            recognition.onend = () => { window.__ended = true; };
            recognition.onerror = event => { window.__error = event.voiceMessage; };
            window.__recognition = recognition; recognition.start();
        });
        await page.waitForFunction(() => window.__started || window.__error);
        assert.equal(await page.evaluate(() => window.__error), undefined);
        await page.evaluate(() => {
            for (let i = 0; i < 7; i++) window.__port.onmessage({ data: new Float32Array(2048).fill(0.02) });
            for (let i = 0; i < 10; i++) window.__port.onmessage({ data: new Float32Array(2048) });
        });
        await page.waitForFunction(() => window.__events.some(event => event.some(result => result.final)) || window.__error);
        const events = await page.evaluate(() => window.__events);
        assert.equal(events[0][0].final, false);
        assert.equal(events.at(-1)[0].text, '刑法第十七条');
        assert.equal(events.at(-1)[0].final, true);
        assert.ok(audioBytes > 0);
        await page.evaluate(() => window.__recognition.stop());
        await page.waitForFunction(() => window.__ended);
        assert.ok(await page.evaluate(() => window.__closed) > 0);
        assert.equal(await page.evaluate(() => window.__error), undefined);
        await page.waitForTimeout(100);
        await page.evaluate(() => { window.__started = false; window.__ended = false; window.__events = []; window.__recognition.start(); });
        await page.waitForFunction(() => window.__started || window.__error);
        await page.evaluate(() => {
            for (let i = 0; i < 7; i++) window.__port.onmessage({ data: new Float32Array(2048).fill(0.02) });
            for (let i = 0; i < 10; i++) window.__port.onmessage({ data: new Float32Array(2048) });
            for (let i = 0; i < 7; i++) window.__port.onmessage({ data: new Float32Array(2048).fill(0.02) });
            window.__recognition.stop();
        });
        await page.waitForFunction(() => window.__ended || window.__error);
        assert.equal(await page.evaluate(() => window.__error), undefined);
        const stoppedEvents = await page.evaluate(() => window.__events);
        assert.equal(stoppedEvents.at(-1).filter(item => item.final).length, 2, '点击完成时句末修正期间已录入的下一句也必须提交');
        assert.equal(finalCount, 3);
    } finally {
        await browser.close(); closeStreaming();
        for (const socket of gateway.clients) socket.terminate();
        await new Promise(resolve => gateway.close(resolve)); await new Promise(resolve => server.close(resolve));
    }
});
