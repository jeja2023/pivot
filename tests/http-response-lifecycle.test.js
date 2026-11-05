'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { onResponseSettled } = require('../server/services/http-response-lifecycle');

test('多个响应观察器共用一个结束监听，正常结束后全部释放且只通知一次', () => {
    const response = new EventEmitter(); const outcomes = [];
    for (let index = 0; index < 30; index += 1) onResponseSettled(response, complete => outcomes.push(complete));
    assert.equal(response.listenerCount('close'), 1); assert.equal(response.listenerCount('finish'), 1);
    response.writableFinished = true; response.emit('finish'); response.emit('close');
    assert.equal(outcomes.length, 30); assert.ok(outcomes.every(Boolean));
    assert.equal(response.listenerCount('close'), 0); assert.equal(response.listenerCount('finish'), 0); assert.equal(response.listenerCount('error'), 0);
});

test('中途断开标记未完成，取消观察不会残留监听', () => {
    const response = new EventEmitter(); const outcomes = [];
    const cancel = onResponseSettled(response, () => { throw new Error('已取消的观察不应调用'); });
    cancel(); assert.equal(response.listenerCount('close'), 0);
    onResponseSettled(response, complete => outcomes.push(complete));
    response.emit('close'); assert.deepEqual(outcomes, [false]);
});

test('已经结束的响应异步通知，允许调用方取消', async () => {
    const response = new EventEmitter(); response.writableFinished = true;
    const outcomes = [];
    onResponseSettled(response, complete => outcomes.push(complete));
    const cancel = onResponseSettled(response, () => outcomes.push('已取消')); cancel();
    await Promise.resolve(); assert.deepEqual(outcomes, [true]);
});
