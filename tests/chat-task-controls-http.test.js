'use strict';

process.env.JWT_SECRET ||= 'pivot-chat-task-http-tests-012345678901234567890123';
const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const http = require('node:http');
const crypto = require('node:crypto');
const { login, register, authMiddleware } = require('../server/auth');
const { queryOne, execute } = require('../server/db/client');
const { createAgentsRouter } = require('../server/routes/agents');
const { monitoring: { getAgentQueue } } = require('../server/services/agent-runtime');
const { approvalInputHash } = require('../server/services/agent-runtime/approvals');

test('任务进度、审批续期、重复决定和暂停接口保留鉴权、归属及参数绑定', async () => {
    const suffix = crypto.randomUUID().slice(0, 12);
    const password = 'ChatTaskHttp123';
    const owner = await register(`feed_owner_${suffix}`, password, '任务所有者', 'QA', 'user');
    const other = await register(`feed_other_${suffix}`, password, '其他账号', 'QA', 'user');
    const session = await login(owner.username, password, { clientIp: '127.0.0.1' });
    const otherSession = await login(other.username, password, { clientIp: '127.0.0.1' });
    const sessionId = crypto.randomUUID();
    const runId = `approval-${crypto.randomUUID()}`;
    const input = { action: 'exec', command: 'python', args: ['token=do-not-publish'], cwd: 'C:\\Private' };
    const pending = { tool: 'terminal.runtime', key: 'approval-one', inputHash: approvalInputHash(input), input,
        requestedAt: '2000-01-01 08:00:00', expiresAt: '2000-01-01 08:15:00' };
    await execute("INSERT INTO sessions (id,user_id,title) VALUES (?,?,'审批测试')", [sessionId, owner.id]);
    await execute("INSERT INTO agent_runs (id,user_id,session_id,title,goal,status,metadata) VALUES (?,?,?,'审批任务','验证审批','approval_required',?)", [runId, owner.id, sessionId,
        JSON.stringify({ chatBridge: { version: 1, sessionId }, pendingApproval: pending, taskContract: { constraints: ['初始要求'] } })]);
    const queue = getAgentQueue();
    const previousConcurrency = queue.getStatus().maxConcurrent;
    queue.updateMaxConcurrent(0);
    const app = express();
    app.use(express.json());
    app.use('/api', createAgentsRouter({ authMiddleware, logAction() {} }));
    app.use((error, _req, res, _next) => res.status(error.status || error.statusCode || 500).json({ error: error.message, code: error.code }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/agents/runs/${runId}`;
    const headers = { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' };
    const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    try {
        assert.equal((await fetch(`${base}/chat-feed`)).status, 401);
        assert.equal((await fetch(`${base}/chat-feed`, { headers: { Authorization: `Bearer ${otherSession.accessToken}` } })).status, 404);
        assert.equal((await fetch(`${base}/chat-feed?limit=101`, { headers })).status, 400);
        const response = await fetch(`${base}/chat-feed`, { headers });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        const feed = await response.json();
        assert.doesNotMatch(JSON.stringify(feed), /do-not-publish|Private/);
        assert.equal((await post('/approval', { approve: true, ...feed.approval.binding })).status, 409);
        const renewed = await post('/approval/refresh', feed.approval.binding);
        assert.equal(renewed.status, 200);
        const latest = await (await fetch(`${base}/chat-feed`, { headers })).json();
        assert.notEqual(latest.approval.binding.requestedAt, feed.approval.binding.requestedAt);
        assert.equal((await post('/approval', { approve: true, ...feed.approval.binding })).status, 409);
        await execute("UPDATE agent_runs SET metadata = jsonb_set(metadata, '{taskContract,constraints}', '[\"更新后的要求\"]'::jsonb) WHERE id = ?", [runId]);
        const approved = await Promise.all([post('/approval', { approve: true, ...latest.approval.binding }), post('/approval', { approve: true, ...latest.approval.binding })]);
        assert.ok(approved.every(item => item.status === 200));
        const record = await queryOne('SELECT status,metadata FROM agent_runs WHERE id = ?', [runId]);
        const metadata = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : record.metadata;
        assert.equal(record.status, 'queued');
        assert.deepEqual(metadata.taskContract.constraints, ['更新后的要求']);
        assert.equal(metadata.approvalGrants.length, 1);
        assert.equal(Number((await queryOne("SELECT COUNT(*) AS count FROM agent_events WHERE run_id = ? AND event_type = 'approval.granted'", [runId])).count), 1);
        const forbiddenPause = await fetch(`${base}/pause`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${otherSession.accessToken}` }, body: '{}' });
        assert.equal(forbiddenPause.status, 404);
        assert.equal((await post('/pause', {})).status, 200);
        const paused = await (await fetch(`${base}/chat-feed`, { headers })).json();
        assert.equal(paused.run.status, 'needs_input');
        assert.equal(paused.pollAfterMs, null);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        await execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
        await execute('DELETE FROM refresh_tokens WHERE user_id IN (?, ?)', [owner.id, other.id]);
        await execute('DELETE FROM users WHERE id IN (?, ?)', [owner.id, other.id]);
        queue.updateMaxConcurrent(previousConcurrency);
    }
});
