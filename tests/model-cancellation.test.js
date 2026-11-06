'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { callModelJson, withAgentModelConcurrency } = require('../server/services/agent-model');
const { callModelTextWithBudget } = require('../server/services/model-text-call');
const { getModelEndpointRuntimeStatus } = require('../server/services/model-runtime');
const { aiSemaphore } = require('../server/services/concurrency');

test('真实模型请求连续被调用方取消后，端点仍可用且两层并发许可全部释放', async () => {
    let controller;
    let requests = 0;
    const server = http.createServer((req, res) => {
        req.resume();
        requests++;
        if (controller) { controller.abort(new Error('调用方不再需要本轮结果')); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '模型正常' } }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const model = { id: 8801, name: '取消回归模型', model_name: 'cancel-test', url: `http://127.0.0.1:${server.address().port}/v1`, max_tokens: 128 };
    const user = { id: 1, role: 'admin' };
    const messages = [{ role: 'user', content: '测试' }];
    const before = aiSemaphore.getStatus();
    try {
        getModelEndpointRuntimeStatus([model]);
        for (let index = 0; index < 4; index++) {
            controller = new AbortController();
            await assert.rejects(() => callModelJson(model, messages, { user, signal: controller.signal, timeoutMs: 30000 }), error => error.code === 'ERR_CANCELED');
        }
        controller = new AbortController();
        await assert.rejects(() => callModelTextWithBudget({ modelCfg: model, user, messages, signal: controller.signal }), error => error.code === 'ERR_CANCELED');
        const cancelled = getModelEndpointRuntimeStatus([model])[0];
        assert.equal(cancelled.errorCount, 0);
        assert.equal(cancelled.consecutiveFailures, 0);
        assert.equal(cancelled.circuitOpenMs, 0);
        assert.equal(cancelled.lastError, '');
        assert.equal(requests, 5);
        assert.equal(cancelled.concurrency.active, 0);
        assert.equal(cancelled.concurrency.queued, 0);
        assert.equal(aiSemaphore.getStatus().active, before.active);
        assert.equal(aiSemaphore.getStatus().queued, before.queued);
        controller = null;
        assert.equal(await callModelJson(model, messages, { user }), '模型正常');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('排队前取消和持有许可时的调用方截止，不记录端点故障且不进入额外操作', async () => {
    const model = { id: 8802, name: '调用截止回归', url: 'http://127.0.0.1:1/v1' };
    getModelEndpointRuntimeStatus([model]);
    const controller = new AbortController();
    controller.abort(new Error('调用方取消'));
    let operations = 0;
    await assert.rejects(() => withAgentModelConcurrency(model, async () => { operations++; }, { signal: controller.signal }), error => error.code === 'REQUEST_ABORTED');
    assert.equal(operations, 0);
    for (let index = 0; index < 4; index++) {
        const deadline = new AbortController();
        await assert.rejects(() => withAgentModelConcurrency(model, async () => {
            deadline.abort(new Error('意图判断等待期限已到'));
            throw new Error('没有取消错误码的网络关闭');
        }, { signal: deadline.signal }), /没有取消错误码/);
    }
    const status = getModelEndpointRuntimeStatus([model])[0];
    assert.equal(status.errorCount, 0);
    assert.equal(status.circuitOpenMs, 0);
    assert.equal(status.concurrency.active, 0);
});
