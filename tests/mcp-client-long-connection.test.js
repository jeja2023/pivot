const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { callMcpJsonRpc, clearMcpSessions } = require('../server/services/mcp-client');

function startMcpServer(requests) {
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            requests.push({ method: req.method, headers: req.headers, body });
            if (body.method === 'initialize') {
                res.writeHead(200, {
                    'content-type': 'application/json',
                    'mcp-session-id': 'stream-session-1'
                });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        protocolVersion: body.params.protocolVersion,
                        capabilities: { tools: {} },
                        serverInfo: { name: 'long-connection-fixture', version: '1.0.0' }
                    }
                }));
                return;
            }
            if (body.method === 'notifications/initialized') {
                res.writeHead(202, { 'content-type': 'application/json' });
                res.end();
                return;
            }
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
                'mcp-session-id': 'stream-session-1'
            });
            res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
            const result = body.method === 'tools/call'
                ? { content: [{ type: 'text', text: 'long stream complete' }] }
                : { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] };
            const response = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
            res.write(`event: message\ndata: ${response.slice(0, Math.floor(response.length / 2))}`);
            setTimeout(() => {
                res.write(`${response.slice(Math.floor(response.length / 2))}\n\n`);
                res.end();
            }, 15);
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function closeServer(server) {
    return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('MCP standard client consumes chunked SSE responses and preserves session headers', async () => {
    const requests = [];
    const server = await startMcpServer(requests);
    const url = `http://127.0.0.1:${server.address().port}`;
    const notifications = [];
    const mcpServer = {
        id: `long-${server.address().port}`,
        base_url: url,
        config: JSON.stringify({ protocolMode: 'standard', protocolVersion: '2025-11-25', timeoutMs: 5000 })
    };
    clearMcpSessions();
    try {
        const listed = await callMcpJsonRpc(mcpServer, 'tools/list', {}, { id: 1, role: 'admin' }, { onNotification: item => notifications.push(item) });
        assert.equal(listed.tools[0].name, 'echo');
        const called = await callMcpJsonRpc(mcpServer, 'tools/call', { name: 'echo', arguments: { value: 'ok' } }, { id: 1, role: 'admin' }, { onNotification: item => notifications.push(item) });
        assert.equal(called.content[0].text, 'long stream complete');
        assert.equal(notifications.some(item => item.method === 'notifications/progress'), true);
        assert.equal(requests[0].body.method, 'initialize');
        assert.equal(requests[1].body.method, 'notifications/initialized');
        assert.equal(requests[2].headers['mcp-session-id'], 'stream-session-1');
        assert.equal(requests[3].headers['mcp-session-id'], 'stream-session-1');
        assert.equal(requests[3].body.method, 'tools/call');
    } finally {
        clearMcpSessions();
        await closeServer(server);
    }
});
