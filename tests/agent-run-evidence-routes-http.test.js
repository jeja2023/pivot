'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'pivot-route-split-test-secret-012345678901234567890123';

const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const test = require('node:test');
const { authMiddleware, login, register } = require('../server/auth');
const { execute } = require('../server/db/client');
const { createAgentsRouter } = require('../server/routes/agents');
const { createTaskTransaction } = require('../server/services/agent-task-transactions');

test('extracted Agent routes retain authentication, ownership and mutation guards over HTTP', async () => {
    const suffix = `${process.pid}${Date.now()}`;
    const password = 'RouteTests123';
    const ownerName = `route_owner_${suffix}`;
    const otherName = `route_other_${suffix}`;
    const owner = await register(ownerName, password, '事务路由测试', 'QA', 'user');
    const other = await register(otherName, password, '隔离测试', 'QA', 'user');
    const ownerSession = await login(ownerName, password, { clientIp: '127.0.0.1' });
    const otherSession = await login(otherName, password, { clientIp: '127.0.0.1' });
    const runId = `route-evidence-${suffix}`;
    await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, '路由测试', '验证路由隔离', 'running', '{}', NOW(), NOW())", [runId, owner.id]);
    await execute("INSERT INTO agent_steps (run_id,step_index,type,title,tool_name,input,output,status) VALUES (?,1,'tool','契约读取','tools.describe',?,?,'error')",
        [runId, JSON.stringify({ toolRef: { toolName: 'mcp.89.render_diagram' }, token: 'private-test-secret' }), JSON.stringify({ code: 'TOOL_POLICY_DENIED', reasonCodes: ['task_tool_allowlist'] })]);
    const transaction = await createTaskTransaction({ run: { id: runId, goal: '验证路由隔离' }, user: owner });
    const app = express();
    app.use(express.json());
    app.use('/api', createAgentsRouter({ authMiddleware, logAction: () => {},
        automationLimiter: (req, res, next) => req.get('x-test-block') === 'yes' ? res.status(429).json({ error: '测试限流' }) : next() }));
    app.use((error, _req, res, _next) => res.status(error.status || error.statusCode || 500).json({ error: error.message, code: error.code }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const headers = token => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
    const request = (path, token, options = {}) => fetch(`${base}${path}`, { ...options, headers: { ...headers(token), ...options.headers } });
    try {
        assert.equal((await fetch(`${base}/agents/runs/${runId}/transactions`)).status, 401);
        const list = await request(`/agents/runs/${runId}/transactions`, ownerSession.accessToken);
        assert.equal(list.status, 200);
        assert.equal((await list.json()).transactions[0].id, transaction.id);
        assert.equal((await request(`/agents/runs/${runId}/transactions`, otherSession.accessToken)).status, 404);
        assert.equal((await request(`/agents/transactions/${transaction.id}`, otherSession.accessToken)).status, 404);
        assert.equal((await request(`/agents/runs/${runId}/evidence`, ownerSession.accessToken)).status, 200);
        assert.equal((await request(`/agents/runs/${runId}/evidence`, otherSession.accessToken)).status, 404);
        const bundle = await request(`/agents/runs/${runId}/audit-bundle?format=json`, ownerSession.accessToken);
        assert.equal(bundle.status, 200);
        const exported = await bundle.json();
        assert.deepEqual(exported.bundle.steps[0].toolDiagnostics.targets, ['mcp.89.render_diagram']);
        assert.equal(JSON.stringify(exported).includes('private-test-secret'), false);
        const markdown = await request(`/agents/runs/${runId}/audit-bundle`, ownerSession.accessToken);
        const body = await markdown.text();
        assert.match(body, /mcp\.89\.render_diagram/);
        assert.match(body, /TOOL_POLICY_DENIED/);
        assert.doesNotMatch(body, /private-test-secret/);
        assert.equal((await request(`/agents/runs/${runId}/audit-bundle`, otherSession.accessToken)).status, 404);
        assert.equal((await request(`/agents/runs/${runId}/browser-sessions`, otherSession.accessToken)).status, 404);
        assert.equal((await request(`/agents/transactions/${transaction.id}/verify`, ownerSession.accessToken, { method: 'POST', body: '{}' })).status, 409);
        assert.equal((await request(`/agents/transactions/${transaction.id}/commit`, ownerSession.accessToken, { method: 'POST', body: '{}', headers: { 'x-test-block': 'yes' } })).status, 429);
        assert.equal((await request('/agents/browser-sessions/missing/recover', ownerSession.accessToken, { method: 'POST', body: '{}' })).status, 409);
        const created = await request('/agents/evaluations/suites', ownerSession.accessToken, { method: 'POST', body: JSON.stringify({ name: '路由回归评测', targetType: 'free', cases: [{ name: '测试用例', input: '验证结果' }] }) });
        assert.equal(created.status, 201);
        const suiteId = (await created.json()).suite.id;
        assert.equal((await request(`/agents/evaluations/suites/${suiteId}`, ownerSession.accessToken)).status, 200);
        assert.equal((await request(`/agents/evaluations/suites/${suiteId}`, otherSession.accessToken)).status, 404);
        assert.equal((await request(`/agents/evaluations/suites/${suiteId}`, ownerSession.accessToken, { method: 'DELETE' })).status, 200);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        await execute('DELETE FROM agent_eval_suites WHERE user_id IN (?, ?)', [owner.id, other.id]);
        await execute('DELETE FROM refresh_tokens WHERE user_id IN (?, ?)', [owner.id, other.id]);
        await execute('DELETE FROM users WHERE id IN (?, ?)', [owner.id, other.id]);
    }
});
