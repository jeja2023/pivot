'use strict';

function isGenericDatabaseTool(tool = {}) {
    return tool.databaseTool === true && String(tool.name || '').startsWith('db.') && Array.isArray(tool.databaseConnections);
}

function validConnections(tool) {
    return (tool.databaseConnections || []).filter(connection => String(connection.fullName || '') === `mcp.${connection.serverId}.${tool.name}`);
}

function toolMatchesAllowlist(tool, allowed = [], input = {}, inspectOnly = false) {
    if (allowed.includes(tool.name)) return true;
    if (!isGenericDatabaseTool(tool)) return false;
    const connections = validConnections(tool);
    if (inspectOnly) return connections.some(connection => allowed.includes(connection.fullName));
    const selection = input.connectionId ?? input.connection_id ?? input.databaseConnectionId ?? input.database_connection_id ?? input.mcpServerId ?? input.mcp_server_id;
    const selectedId = selection == null ? (connections.length === 1 ? String(connections[0].connectionId ?? connections[0].serverId) : '') : String(selection);
    return connections.some(connection => (String(connection.connectionId ?? connection.serverId) === selectedId || String(connection.serverId) === selectedId)
        && allowed.includes(connection.fullName));
}

function narrowDatabaseConnections(tool, allowlists = []) {
    if (!isGenericDatabaseTool(tool)) return tool;
    const connections = validConnections(tool).filter(connection => allowlists.every(list => !list.length || list.includes(tool.name) || list.includes(connection.fullName)));
    if (!connections.length) return null;
    const ids = connections.map(connection => String(connection.serverId));
    const schema = tool.input_schema || tool.inputSchema || {};
    const property = schema.properties?.connectionId || { type: 'string' };
    return { ...tool, databaseConnections: connections, input_schema: { ...schema, properties: { ...(schema.properties || {}),
        connectionId: { ...property, enum: ids, default: ids.includes(String(property.default)) ? property.default : ids[0] }
    } } };
}

module.exports = { narrowDatabaseConnections, toolMatchesAllowlist };
