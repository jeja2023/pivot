'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSseResponseWriter } = require('../server/services/sse-response');

function response() {
    const res = new EventEmitter();
    res.write = () => false;
    res.destroy = () => { res.destroyed = true; res.emit('close'); };
    return res;
}

test('反复发生背压时不重复注册 drain 监听，结束后释放待处理资源', () => {
    const res = response(); const writer = createSseResponseWriter(res, { setHeaders: false, heartbeatMs: 0 });
    for (let index = 0; index < 50; index += 1) {
        writer.writeData({ index });
        res.emit('drain');
        assert.equal(res.listenerCount('drain'), 1);
    }
    writer.cleanup();
    assert.equal(res.listenerCount('drain'), 0); assert.equal(res.listenerCount('close'), 0);
    assert.equal(writer.isWritable(), false);
});

test('主动停止时立即结束所有背压等待，不等待超时或保留结束监听', async () => {
    const res = response(); res.writableNeedDrain = true;
    const writer = createSseResponseWriter(res, { setHeaders: false, heartbeatMs: 0 });
    writer.writeData('等待发送');
    const pending = writer.waitForDrain(30000);
    writer.cleanup();
    assert.equal(await pending, false);
    assert.equal(res.listenerCount('drain'), 0); assert.equal(res.listenerCount('close'), 0);
});
