'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { safeJsonGet, safeJsonPost, safeJsonRequest } = require('../server/services/safe-http-client');

test('安全 HTTP 请求默认拒绝非成功状态，显式状态策略仍可生效', async () => {
    const server = http.createServer((_req, res) => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: '未授权' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const options = { assertUrl: async () => {}, createAgents: () => ({}) };
    try {
        await assert.rejects(safeJsonGet(url, options), error => error.response?.status === 401);
        await assert.rejects(safeJsonPost(url, { prompt: '测试' }, options), error => error.response?.status === 401);
        await assert.rejects(safeJsonRequest({ ...options, url, method: 'put', data: { prompt: '测试' } }), error => error.response?.status === 401);
        const response = await safeJsonGet(url, { ...options, validateStatus: status => status === 401 });
        assert.equal(response.status, 401);
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
