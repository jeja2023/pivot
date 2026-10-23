'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { callMcpJsonRpc, clearMcpSessions } = require('../server/services/mcp-client');

test('真实 FastMCP 服务拒绝匿名请求，协议握手、规则扫描和请求上限有效', { skip: !process.env.PIVOT_OFFLINE_TOOLS_PYTHON }, async () => {
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const token = crypto.randomBytes(32).toString('hex');
    const child = spawn(process.env.PIVOT_OFFLINE_TOOLS_PYTHON, ['-c', 'import os,uvicorn; from app import create_app; uvicorn.run(create_app(os.environ["TEST_TOOLS_TOKEN"]),host="127.0.0.1",port=int(os.environ["TEST_TOOLS_PORT"]),access_log=False)'], {
        cwd: path.resolve(__dirname, '../docker/offline-tools'), env: { ...process.env, TEST_TOOLS_TOKEN: token, TEST_TOOLS_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
    });
    let startupError = '';
    child.stderr.on('data', chunk => { startupError = (startupError + chunk).slice(-2000); });
    const base = `http://127.0.0.1:${port}`;
    try {
        let ready = false;
        for (let attempt = 0; attempt < 200; attempt++) {
            if (child.exitCode !== null) break;
            try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch (_) { /* 等待隔离服务启动。 */ }
            await delay(100);
        }
        assert.equal(ready, true, '真实 Python 服务应能启动：' + startupError);
        assert.equal((await fetch(base + '/mcp', { method: 'POST', body: '{}' })).status, 401);
        assert.equal((await fetch(base + '/mcp', { method: 'POST', body: 'x'.repeat(524289), headers: { Authorization: `Bearer ${token}` } })).status, 413);
        const server = { id: 'real-sdk-test', base_url: base + '/mcp', api_key: token, config: JSON.stringify({ protocolMode: 'standard', protocolVersion: '2025-11-25', authMode: 'bearer' }) };
        const user = { id: 1, role: 'admin' };
        const catalog = await callMcpJsonRpc(server, 'tools/list', {}, user);
        assert.ok(catalog.tools.some(tool => tool.name === 'run_ast_audit'));
        const result = await callMcpJsonRpc(server, 'tools/call', { name: 'run_ast_audit', arguments: { source_code: 'import os as o\no.system(value)' } }, user);
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.pivotArtifact.data.issues_count, 1);
        const invalid = await callMcpJsonRpc(server, 'tools/call', { name: 'run_ast_audit', arguments: { source_code: '' } }, user);
        assert.equal(invalid.structuredContent.pivotArtifact.data.status, 'not_scanned');
    } finally {
        clearMcpSessions();
        child.kill();
        await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    }
});
