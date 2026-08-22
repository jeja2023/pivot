#!/usr/bin/env node

const { callMcpJsonRpc, clearMcpSessions } = require('../server/services/mcp-client');

const scenario = String(process.env.MCP_CONFORMANCE_SCENARIO || '').trim();
const protocolVersion = String(process.env.MCP_CONFORMANCE_PROTOCOL_VERSION || '2025-11-25').trim();
const serverUrl = String(process.argv.at(-1) || '').trim();

function createServer(url) {
    return {
        id: `official-conformance:${scenario}:${url}`,
        base_url: url,
        config: JSON.stringify({
            protocolMode: 'standard',
            protocolVersion,
            timeoutMs: 30000,
            maxReconnects: 3
        })
    };
}

async function run() {
    if (!scenario || !serverUrl) throw new Error('缺少 MCP conformance 场景或服务地址。');
    const server = createServer(serverUrl);
    const user = { id: 1, role: 'admin' };
    clearMcpSessions();
    if (scenario === 'initialize') {
        await callMcpJsonRpc(server, 'initialize', {
            protocolVersion,
            capabilities: { tools: {} },
            clientInfo: { name: 'pivot-conformance-client', version: '0.1.23' }
        }, user, { protocolVersion });
    } else if (scenario === 'tools_call' || scenario === 'tools-call' || scenario === 'sse-retry') {
        const listed = await callMcpJsonRpc(server, 'tools/list', {}, user, { protocolVersion });
        const tool = Array.isArray(listed?.tools) ? listed.tools[0] : null;
        if (!tool?.name) throw new Error('MCP conformance 服务未返回可调用工具。');
        const argumentsPayload = tool.name === 'add_numbers' ? { a: 2, b: 3 } : {};
        await callMcpJsonRpc(server, 'tools/call', {
            name: tool.name,
            arguments: argumentsPayload
        }, user, { protocolVersion, maxReconnects: 4 });
    } else {
        await callMcpJsonRpc(server, 'initialize', {
            protocolVersion,
            capabilities: { tools: {} },
            clientInfo: { name: 'pivot-conformance-client', version: '0.1.23' }
        }, user, { protocolVersion });
    }
    process.stdout.write(JSON.stringify({ ok: true, scenario, protocolVersion }));
}

run().catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
});
