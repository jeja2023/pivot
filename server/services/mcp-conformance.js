const MCP_PROTOCOL_VERSION = '2024-11-05';

function conformanceError(message, details = {}) {
    const error = new Error(message);
    error.code = 'MCP_CONFORMANCE_FAILED';
    error.details = details;
    return error;
}

function assertJsonRpcEnvelope(response, method) {
    if (!response || response.jsonrpc !== '2.0') {
        throw conformanceError(`${method} 返回的 JSON-RPC envelope 无效。`, { method, response });
    }
    if (response.error) {
        throw conformanceError(`${method} 返回 JSON-RPC 错误：${response.error.message || response.error.code || 'unknown'}`, {
            method,
            error: response.error
        });
    }
    if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
        throw conformanceError(`${method} 缺少 result 字段。`, { method, response });
    }
    return response.result;
}

function normalizeHeaders(headers = {}) {
    return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [String(key).toLowerCase(), value]));
}

/**
 * Run the minimum Streamable HTTP MCP lifecycle against an injected transport.
 * The transport keeps network and authentication outside this deterministic test harness.
 */
async function runMcpConformanceSuite({ request, toolName = '', toolArguments = {} } = {}) {
    if (typeof request !== 'function') throw new TypeError('MCP conformance harness 需要 request 函数。');
    const calls = [];
    const send = async (method, params, headers = {}, notification = false) => {
        const entry = { method, params, headers: { ...headers }, notification };
        calls.push(entry);
        const response = await request(entry);
        if (notification) return response || null;
        assertJsonRpcEnvelope(response, method);
        return response;
    };

    const initialize = await send('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: 'Pivot-MCP-Conformance', version: '0.1.22' }
    });
    const initializeResult = initialize.result;
    const negotiatedVersion = String(initializeResult?.protocolVersion || '');
    if (!negotiatedVersion) throw conformanceError('initialize 未返回 protocolVersion。', { initializeResult });
    const responseHeaders = normalizeHeaders(initialize.headers);
    const sessionId = String(responseHeaders['mcp-session-id'] || '').trim();
    const sessionHeaders = sessionId ? { 'Mcp-Session-Id': sessionId } : {};
    await send('notifications/initialized', {}, sessionHeaders, true);

    const listed = await send('tools/list', {}, sessionHeaders);
    const tools = Array.isArray(listed.result?.tools) ? listed.result.tools : null;
    if (!tools) throw conformanceError('tools/list 未返回 tools 数组。', { result: listed.result });
    const selected = toolName
        ? tools.find(tool => String(tool?.name || '') === String(toolName))
        : tools[0];
    if (!selected) throw conformanceError('tools/list 未找到可调用工具。', { toolName, tools });

    const called = await send('tools/call', {
        name: selected.name,
        arguments: toolArguments && typeof toolArguments === 'object' ? toolArguments : {}
    }, sessionHeaders);
    if (!called.result || typeof called.result !== 'object') {
        throw conformanceError('tools/call 返回结果不是对象。', { result: called.result });
    }
    return {
        protocolVersion: negotiatedVersion,
        sessionId,
        tool: selected.name,
        toolCount: tools.length,
        calls,
        result: called.result
    };
}

module.exports = {
    MCP_PROTOCOL_VERSION,
    assertJsonRpcEnvelope,
    runMcpConformanceSuite
};
