'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const test = require('node:test');
const { register, login, authMiddleware } = require('../server/auth');
const { execute } = require('../server/db/client');
const { createWorkflowTemplatesRouter } = require('../server/routes/agent/workflowTemplates');

test('私有模板评分通过真实认证校验所有权，并拒绝非整数评分', async () => {
    const suffix = `${process.pid.toString(36)}${Date.now().toString(36)}`;
    const password = 'TemplatePass123';
    const ownerName = `template_owner_${suffix}`;
    const otherName = `template_other_${suffix}`;
    const owner = await register(ownerName, password, '模板所有者', 'QA');
    const other = await register(otherName, password, '其他用户', 'QA');
    const app = express();
    app.use(express.json());
    app.use('/api', createWorkflowTemplatesRouter({ authMiddleware, logAction: () => {} }));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/agent/workflow-templates`;
    try {
        const ownerToken = (await login(ownerName, password, { clientIp: '127.0.0.1' })).accessToken;
        const otherToken = (await login(otherName, password, { clientIp: '127.0.0.1' })).accessToken;
        const request = (url, token, body) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const created = await request(base, ownerToken, {
            name: `私有模板 ${suffix}`, slug: `private-${suffix}`, isPublic: false,
            dagSpecTemplate: { nodes: [{ id: 'one' }] }
        });
        assert.equal(created.status, 201);
        const id = (await created.json()).data.id;
        const endpoint = `${base}/${id}/rate`;
        assert.equal((await request(endpoint, otherToken, { rating: 5 })).status, 403);
        for (const rating of [1.5, '3.5', '3abc', null, 0, 6]) {
            assert.equal((await request(endpoint, ownerToken, { rating })).status, 400);
        }
        const allowed = await request(endpoint, ownerToken, { rating: 5 });
        assert.equal(allowed.status, 200);
        assert.equal((await allowed.json()).data.template_count, 1);
        assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"rating":5}' })).status, 401);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await execute('DELETE FROM refresh_tokens WHERE user_id IN (?, ?)', [owner.id, other.id]);
        await execute('DELETE FROM users WHERE id IN (?, ?)', [owner.id, other.id]);
    }
});
