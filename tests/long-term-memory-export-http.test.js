'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'pivot-memory-export-test-secret-012345678901234567890123';

const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const test = require('node:test');
const { authMiddleware, login, register } = require('../server/auth');
const { execute } = require('../server/db/client');
const { createMemoriesRouter } = require('../server/routes/memories');

test('长期记忆导出 HTTP 分页结束且严格隔离用户', async () => {
    const suffix = `${process.pid}${Date.now()}`;
    const password = 'ExportTests123';
    const ownerName = `exp_o_${suffix}`;
    const otherName = `exp_x_${suffix}`;
    const owner = await register(ownerName, password, '导出测试', 'QA', 'user');
    const other = await register(otherName, password, '隔离测试', 'QA', 'user');
    const ownerSession = await login(ownerName, password, { clientIp: '127.0.0.1' });
    const otherSession = await login(otherName, password, { clientIp: '127.0.0.1' });
    for (let index = 0; index < 7; index++) {
        await execute("INSERT INTO memories (user_id, type, content, salience, status, created_at, updated_at) VALUES (?, 'fact', ?, 0.5, 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", [owner.id, `导出测试 ${index}`]);
    }
    await execute("INSERT INTO memories (user_id, type, content, status) VALUES (?, 'fact', '其他用户的私有记忆', 'active')", [other.id]);
    const app = express();
    app.use('/api', createMemoriesRouter({ authMiddleware, logAction: () => {} }));
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message, code: error.code }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/memories/export`;
    const request = (token, query = '') => fetch(`${base}${query}`, { headers: { Authorization: `Bearer ${token}` } });
    try {
        assert.equal((await fetch(base)).status, 401);
        const first = await (await request(ownerSession.accessToken, '?pageSize=2&maxRecords=3')).json();
        assert.equal(first.export.total, 7);
        assert.equal(first.export.nextOffset, 3);
        assert.equal(first.export.memories.length, 3);
        const second = await (await request(ownerSession.accessToken, '?pageSize=2&maxRecords=3&offset=3')).json();
        assert.equal(second.export.nextOffset, 6);
        const last = await (await request(ownerSession.accessToken, '?pageSize=2&maxRecords=3&offset=6')).json();
        assert.equal(last.export.complete, true);
        assert.equal(last.export.nextOffset, null);
        assert.equal(last.export.consistency, 'best_effort');
        const rows = [...first.export.memories, ...second.export.memories, ...last.export.memories];
        assert.equal(new Set(rows.map(row => String(row.id))).size, 7);
        assert.ok(rows.every(row => Number(row.userId) === Number(owner.id)));
        const otherExport = await (await request(otherSession.accessToken)).json();
        assert.equal(otherExport.export.total, 1);
        assert.equal(Number(otherExport.export.memories[0].userId), Number(other.id));
        const snapshot = await (await request(ownerSession.accessToken, '?snapshot=true&maxRecords=10')).json();
        assert.equal(snapshot.export.consistency, 'repeatable_read_snapshot');
        assert.equal(snapshot.export.complete, true);
        assert.equal(snapshot.export.total, 7);
        assert.equal(snapshot.export.memories.length, 7);
        const invalid = await request(ownerSession.accessToken, '?offset=-1');
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.json()).code, 'MEMORY_EXPORT_OFFSET_INVALID');
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await execute('DELETE FROM memories WHERE user_id IN (?, ?)', [owner.id, other.id]);
        await execute('DELETE FROM refresh_tokens WHERE user_id IN (?, ?)', [owner.id, other.id]);
        await execute('DELETE FROM users WHERE id IN (?, ?)', [owner.id, other.id]);
    }
});
