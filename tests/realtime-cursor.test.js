'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { normalizeRealtimeCursor } = require('../server/services/realtime-cursor');
const { publishUserEvent, subscribeUserEvents } = require('../server/services/realtime-events');

test('SSE 持久游标保留 bigint 精度并拒绝非事件标识', () => {
    assert.equal(normalizeRealtimeCursor('9007199254740993'), '9007199254740993');
    assert.equal(normalizeRealtimeCursor(9007199254740992), '0');
    for (const invalid of ['run:123', '-1', '9223372036854775808', '1\nid: 2', '0']) {
        assert.equal(normalizeRealtimeCursor(invalid), '0');
    }
    assert.equal(normalizeRealtimeCursor('00042'), '42');
});

test('只有持久 Agent 事件设置 SSE 重连 ID', () => {
    const res = new EventEmitter();
    const chunks = [];
    res.setHeader = () => {};
    res.write = chunk => { chunks.push(String(chunk)); return true; };
    const unsubscribe = subscribeUserEvents({ id: 987654 }, res, { heartbeatMs: 0 });
    try {
        publishUserEvent(987654, 'agent.event', { eventId: '9007199254740993', runId: 'run', eventSeq: 4 });
        publishUserEvent(987654, 'presentation.updated', { eventId: '5' });
        publishUserEvent(987654, 'agent.streaming', { runId: 'run', eventSeq: 5 });
        const frames = chunks.join('').split('\n\n');
        const persistent = frames.find(frame => frame.includes('event: agent.event'));
        const presentation = frames.find(frame => frame.includes('event: presentation.updated'));
        const streaming = frames.find(frame => frame.includes('event: agent.streaming'));
        assert.match(persistent, /^id: 9007199254740993\n/);
        assert.doesNotMatch(presentation, /^id:/m);
        assert.doesNotMatch(streaming, /^id:/m);
    } finally { unsubscribe(); }
});
