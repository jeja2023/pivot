'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { closeAgentBrowserContext } = require('../server/services/agent-browser');

test('并发关闭共用完整退出确认，页面关闭后的重试不能提前返回', async () => {
    let finishContext, contexts = 0, completed = false, pageClosed = false;
    const contextClosed = new Promise(resolve => { finishContext = resolve; });
    const context = { close: async () => { contexts++; if (pageClosed) return; pageClosed = true; await contextClosed; } };
    const first = closeAgentBrowserContext(context).then(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve));
    const second = closeAgentBrowserContext(context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(contexts, 1); assert.equal(completed, false);
    finishContext(); await Promise.all([first, second]); assert.equal(completed, true);
    await closeAgentBrowserContext(context); assert.equal(contexts, 1);
});

test('关闭异常不缓存为已确认，可以重试', async () => {
    let calls = 0;
    const context = { close: async () => { if (++calls === 1) throw Error('模拟关闭失败'); } };
    await assert.rejects(closeAgentBrowserContext(context), /模拟关闭失败/);
    await closeAgentBrowserContext(context); assert.equal(calls, 2);
});
