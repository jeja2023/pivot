'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createModelsRouter } = require('../server/routes/models');

test('模型连接测试拒绝非文本地址、密钥和模型名称', async () => {
    const app = express();
    app.use(express.json());
    app.use(createModelsRouter({
        authMiddleware: (req, _res, next) => { req.user = { id: 1, role: 'admin', username: 'admin' }; req.log = { debug() {}, info() {}, error() {} }; next(); },
        logAction() {},
        normalizePage: () => 1,
        normalizeLimit: () => 10,
        probeLimiter: (_req, _res, next) => next()
    }));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        for (const input of [{ url: 42 }, { url: 'https://example.com', api_key: {} }, { url: 'https://example.com', model_name: [] }]) {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/models/test`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
            });
            assert.equal(response.status, 400);
            assert.match((await response.json()).error, /文本/);
        }
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
