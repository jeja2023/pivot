'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('旧流式服务不接管进程信号，关闭时停止心跳并释放异常会话', async () => {
    const before = { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') };
    const service = require('../server/services/agent-runtime/streaming-service');
    assert.equal(process.listenerCount('SIGTERM'), before.term);
    assert.equal(process.listenerCount('SIGINT'), before.int);
    assert.equal(service.heartbeatTimer.hasRef(), false);
    let ended = false;
    service.activeSessions.set('shutdown-test', { res: { end() { ended = true; } }, startTime: Date.now(), eventCount: 0 });
    service.sessionBuffers.set('shutdown-test', []);
    await service.cleanup();
    assert.equal(ended, true);
    assert.equal(service.activeSessions.size, 0);
    assert.equal(service.sessionBuffers.size, 0);
    assert.equal(service.heartbeatTimer, null);
    service.startHeartbeat();
    assert.equal(service.heartbeatTimer.hasRef(), false);
    await service.cleanup();
});
