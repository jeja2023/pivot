'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { callMcpJsonRpc, clearMcpSessions, usesStatelessMcpTransport } = require('../server/services/mcp-client');

function startServer(requests) {
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            requests.push({ headers: req.headers, body });
            const result = body.method === 'tools/call'
                ? { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } }
                : { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('2026 MCP Streamable HTTP is stateless and carries method/name routing headers', async () => {
    const requests = [];
    const server = await startServer(requests);
    const mcpServer = {
        id: `stateless-${server.address().port}`,
        base_url: `http://127.0.0.1:${server.address().port}`,
        config: JSON.stringify({ protocolMode: 'standard', protocolVersion: '2026-07-28', timeoutMs: 5000 })
    };
    try {
        assert.equal(usesStatelessMcpTransport('2026-07-28'), true);
        const listed = await callMcpJsonRpc(mcpServer, 'tools/list', {}, { id: 1, role: 'admin' });
        assert.equal(listed.tools[0].name, 'echo');
        const result = await callMcpJsonRpc(mcpServer, 'tools/call', { name: 'echo', arguments: {} }, { id: 1, role: 'admin' }, {
            traceContext: { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', baggage: 'pivot.run=run-1' }
        });
        assert.equal(result.structuredContent.ok, true);
        assert.equal(requests.length, 2);
        assert.equal(requests[0].body.method, 'tools/list');
        assert.equal(requests[0].headers['mcp-method'], 'tools/list');
        assert.equal(requests[1].headers['mcp-method'], 'tools/call');
        assert.equal(requests[1].headers['mcp-name'], 'echo');
        assert.equal(requests[1].headers.traceparent, '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01');
        assert.equal(requests[1].body.params._meta.baggage, 'pivot.run=run-1');
        assert.equal(requests.some(request => request.body.method === 'initialize'), false);
    } finally {
        clearMcpSessions();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
