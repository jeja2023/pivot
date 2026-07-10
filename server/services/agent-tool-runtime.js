const { clampText, executeBuiltInTool } = require('./agent-tools');
const { executeMcpTool } = require('./mcp-client');

function findDatabaseCompatTool(fullName, toolList = []) {
    const match = String(fullName || '').match(/^mcp\.(\d+)\.(db\..+)$/);
    if (!match) return null;
    const serverId = match[1];
    const shortName = match[2];
    return (toolList || []).find(tool => {
        if (!tool?.databaseTool || tool.name !== shortName) return false;
        const connections = Array.isArray(tool.databaseConnections) ? tool.databaseConnections : [];
        return connections.some(connection => (
            String(connection.serverId ?? '') === serverId
            && String(connection.fullName || '') === String(fullName || '')
        ));
    }) || null;
}

function findAgentToolByName(name, toolList = []) {
    const safeName = String(name || '').trim();
    return (toolList || []).find(item => item.name === safeName) || findDatabaseCompatTool(safeName, toolList);
}

async function executeToolByName(name, input, user, toolList = [], context = {}) {
    const safeName = String(name || '').trim();
    const tool = findAgentToolByName(safeName, toolList);
    if (!tool) {
        const err = new Error(`工具不可用或无权访问：${safeName || '-'}`);
        err.status = 403;
        throw err;
    }
    if (safeName.startsWith('mcp.')) {
        return executeMcpTool(safeName, input, user, { source: 'agent' });
    }
    if (tool.databaseTool && safeName.startsWith('db.')) {
        const rawConnectionId = input?.connectionId ?? input?.connection_id ?? input?.databaseConnectionId ?? input?.database_connection_id ?? input?.mcpServerId ?? input?.mcp_server_id;
        const connections = Array.isArray(tool.databaseConnections) ? tool.databaseConnections : [];
        const selectedConnectionId = String(rawConnectionId ?? '').trim()
            || (connections.length === 1 ? String(connections[0].connectionId ?? connections[0].serverId ?? '') : '');
        const connection = connections.find(item => (
            String(item.connectionId ?? item.serverId ?? '') === selectedConnectionId
            || String(item.serverId ?? '') === selectedConnectionId
        ));
        if (!connection?.fullName) {
            const err = new Error('请为这个数据库工具选择一个可用的数据连接。');
            err.status = 400;
            throw err;
        }
        const toolInput = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
        delete toolInput.connectionId;
        delete toolInput.connection_id;
        delete toolInput.databaseConnectionId;
        delete toolInput.database_connection_id;
        delete toolInput.mcpServerId;
        delete toolInput.mcp_server_id;
        return executeMcpTool(connection.fullName, toolInput, user, { source: 'agent' });
    }
    return executeBuiltInTool(safeName, input, user, context);
}

module.exports = {
    clampText,
    executeToolByName,
    findAgentToolByName,
    findDatabaseCompatTool
};
