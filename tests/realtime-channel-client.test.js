'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('渠道使用独立游标并在无消费者时不推进，重连携带已处理游标', () => {
    const sources = [];
    class Source {
        constructor(url) { this.url = url; this.handlers = {}; this.closed = false; sources.push(this); }
        addEventListener(type, handler) { this.handlers[type] = handler; }
        close() { this.closed = true; }
        emit(type, event) { this.handlers[type]?.(event); }
    }
    let api;
    const values = new Map();
    const context = { currentUser: { id: 42 }, currentSessionId: '', API_BASE: '/api', EventSource: Source,
        sessionStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
        document: { hidden: false, addEventListener() {} }, setTimeout, clearTimeout,
        window: { EventSource: Source, addEventListener() {}, Pivot: {
            moduleApi: () => ({}), exposeModule(_name, value) { api = value; }
        } } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/chat-task-controller.js'), 'utf8'), context);
    const stopPresentation = api.subscribe(() => {});
    sources[0].emit('connected', { data: JSON.stringify({ channelFeed: true }) });
    assert.equal(sources.length, 1);
    const received = [];
    const stopChannel = api.subscribe((type, event) => { if (type === 'agent.channel') received.push(event.data); }, { channel: true });
    assert.equal(sources[1].url, '/api/events/channels');
    sources[1].emit('channel.connected', { lastEventId: '7' });
    sources[0].emit('agent.channel', { data: '{"deliveryId":"4","body":"one"}' });
    sources[1].emit('agent.channel', { lastEventId: '8', data: '{"deliveryId":"4","body":"one"}' });
    assert.deepEqual(received, ['{"deliveryId":"4","body":"one"}']);
    assert.equal(values.get('pivot_channel_cursor_42'), '8');
    stopChannel();
    assert.equal(sources[1].closed, true);
    const stopAgain = api.subscribe(() => {}, { channel: true });
    assert.equal(sources[2].url, '/api/events/channels?after=8');
    sources[0].emit('connected', { data: '{}' });
    assert.equal(sources[2].closed, true);
    sources[0].emit('connected', { data: JSON.stringify({ channelFeed: true }) });
    assert.equal(sources[3].url, '/api/events/channels?after=8');
    const fail = api.subscribe(() => { throw new Error('消费者处理失败'); }, { channel: true });
    sources[3].emit('channel.connected', { lastEventId: '8' });
    sources[3].emit('agent.channel', { lastEventId: '9', data: '{"deliveryId":"5","body":"two"}' });
    assert.equal(sources[3].closed, true);
    assert.equal(values.get('pivot_channel_cursor_42'), '8');
    fail();
    stopAgain(); stopPresentation();
    assert.equal(sources[0].closed, true);
});

test('旧服务未声明独立渠道能力时不会建立新端点连接', () => {
    const sources = [];
    class Source {
        constructor(url) { this.url = url; this.handlers = {}; sources.push(this); }
        addEventListener(type, handler) { this.handlers[type] = handler; }
        close() {}
    }
    let api;
    const context = { currentUser: { id: 7 }, currentSessionId: '', API_BASE: '/api', EventSource: Source,
        sessionStorage: { getItem() {}, setItem() {} }, document: { hidden: false, addEventListener() {} }, setTimeout, clearTimeout,
        window: { EventSource: Source, addEventListener() {}, Pivot: { moduleApi: () => ({}), exposeModule(_name, value) { api = value; } } } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/chat-task-controller.js'), 'utf8'), context);
    const stop = api.subscribe(() => {}, { channel: true });
    sources[0].handlers.connected({ data: '{}' });
    assert.equal(sources.length, 1);
    stop();
});
