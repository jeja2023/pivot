const { getBuiltInToolDefinitions } = require('./agent-tools');
const { listCachedMcpTools } = require('./mcp-client');
const {
    filterBuiltInToolsByCapability,
    filterMcpToolsByCapability
} = require('./capability-market');
const {
    normalizeToolAllowlist,
    normalizeToolPolicy
} = require('./agent-validators');
const { normalizeToolContract } = require('./agent-contracts');

async function formatToolList(user, options = {}) {
    const policy = normalizeToolPolicy(options.toolPolicy);
    const allowlist = normalizeToolAllowlist(options.toolAllowlist);
    const allowed = allowlist.length ? new Set(allowlist) : null;
    const isAllowed = (name, source, aliases = []) => {
        if (policy === 'builtin_only' && source === 'mcp') return false;
        if (allowed && !allowed.has(name) && !aliases.some(alias => allowed.has(alias))) return false;
        return true;
    };
    const builtInDefs = await filterBuiltInToolsByCapability(getBuiltInToolDefinitions(user), user);
    const builtIns = builtInDefs.map(tool => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        input_schema: tool.input_schema,
        source: 'builtin',
        risk: 'low',
        requiresApproval: Boolean(tool.alwaysRequiresApproval),
        alwaysRequiresApproval: Boolean(tool.alwaysRequiresApproval),
        admin: Boolean(tool.admin)
    })).filter(tool => isAllowed(tool.name, 'builtin'));
    // 内置工具已统一提供 viz.build_chart 等能力；当用户另外添加了系统可视化等内置 MCP 服务时，
    // 缓存的工具名（如 viz.build_chart）会与内置工具同名而在目录中重复。这里仅对系统内置 MCP 按裸工具名去重；
    // 外部第三方 MCP 即使短名相同，也保留完整 mcp.<id>.* 工具名，避免把语义/参数不同的工具误折叠。
    const builtinToolNames = new Set(builtIns.map(tool => tool.name));
    const cachedTools = await listCachedMcpTools(null, user);
    const filteredMcp = await filterMcpToolsByCapability(cachedTools, user);
    const cachedMcpTools = filteredMcp
        .filter(tool => tool.serverType === 'external' || !builtinToolNames.has(String(tool.name || '')));
    const databaseTools = buildGenericDatabaseTools(cachedMcpTools)
        .map(tool => filterDatabaseToolForPolicy(tool, policy, allowed))
        .filter(Boolean);
    const mcpTools = cachedMcpTools
        .filter(tool => tool.serverType !== 'database')
        .map(tool => ({
            name: tool.fullName,
            title: tool.title || tool.name,
            description: `[${tool.serverName}] ${tool.description || tool.name}`,
            input_schema: tool.input_schema,
            source: 'mcp',
            risk: tool.governance?.riskLevel || 'high',
            requiresApproval: Boolean(tool.governance?.approvalRequired || tool.governance?.riskLevel === 'high' || !tool.governance),
            governance: tool.governance || {},
            serverName: tool.serverName,
            owner: tool.owner || null
        }))
        .filter(tool => isAllowed(tool.name, 'mcp'));
    return [...builtIns, ...databaseTools, ...mcpTools].map(tool => {
        const contract = normalizeToolContract(tool);
        return {
            ...tool,
            version: contract.version,
            capabilities: contract.capabilities,
            risk_level: contract.risk_level,
            idempotent: contract.idempotent,
            side_effect: contract.side_effect,
            concurrency: contract.concurrency,
            cancellable: contract.cancellable,
            network: contract.network,
            approval_required: contract.approval_required,
            timeout: contract.timeout,
            output_schema: contract.output_schema
        };
    });
}

function cloneJson(value, fallback = {}) {
    try {
        return JSON.parse(JSON.stringify(value || fallback)) || fallback;
    } catch (e) {
        return fallback;
    }
}

function buildDatabaseToolSchema(schema, connections) {
    const next = cloneJson(schema, { type: 'object', properties: {} });
    next.type = 'object';
    const properties = next.properties && typeof next.properties === 'object' ? next.properties : {};
    const ids = connections.map(item => String(item.serverId)).filter(Boolean);
    const connectionProperty = {
        type: 'string',
        enum: ids,
        default: ids[0] || '',
        description: 'Database connection ID used by Pivot to choose the concrete database MCP server.'
    };
    delete properties.connectionId;
    delete properties.databaseConnectionId;
    delete properties.database_connection_id;
    delete properties.mcpServerId;
    delete properties.mcp_server_id;
    next.properties = {
        connectionId: connectionProperty,
        ...properties
    };
    const required = new Set(Array.isArray(next.required) ? next.required : []);
    required.delete('databaseConnectionId');
    required.delete('database_connection_id');
    required.delete('mcpServerId');
    required.delete('mcp_server_id');
    required.add('connectionId');
    next.required = [...required];
    return next;
}

function buildGenericDatabaseTools(tools = []) {
    const grouped = new Map();
    tools
        .filter(tool => tool.serverType === 'database' && String(tool.name || '').startsWith('db.'))
        .forEach(tool => {
            const name = String(tool.name || '').trim();
            if (!name) return;
            if (!grouped.has(name)) grouped.set(name, []);
            grouped.get(name).push(tool);
        });
    return [...grouped.entries()].map(([name, items]) => {
        const first = items[0] || {};
        const governance = items.reduce((current, item) => {
            const next = item.governance || {};
            if (!current) return next;
            return {
                ...current,
                riskLevel: next.riskLevel === 'high' || current.riskLevel === 'high'
                    ? 'high'
                    : next.riskLevel === 'medium' || current.riskLevel === 'medium' ? 'medium' : 'low',
                approvalRequired: Boolean(current.approvalRequired || next.approvalRequired),
                enabled: Boolean(current.enabled && next.enabled)
            };
        }, null) || {};
        const risk = governance.riskLevel || 'low';
        const connections = items.map(tool => ({
            serverId: String(tool.serverId ?? ''),
            connectionId: String(tool.serverId ?? ''),
            serverName: tool.serverName || `Database ${tool.serverId}`,
            databaseType: tool.databaseType || '',
            fullName: tool.fullName,
            owner: tool.owner || null
        })).filter(item => item.serverId);
        return {
            name,
            title: name,
            description: first.description || name,
            input_schema: buildDatabaseToolSchema(first.input_schema, connections),
            source: 'mcp',
            risk,
            requiresApproval: Boolean(governance.approvalRequired || risk === 'high'),
            governance,
            serverName: 'Database connections',
            databaseTool: true,
            databaseConnections: connections
        };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

function filterDatabaseToolForPolicy(tool, policy, allowed) {
    if (!tool || policy === 'builtin_only') return null;
    const connections = Array.isArray(tool.databaseConnections) ? tool.databaseConnections : [];
    if (!allowed || allowed.has(tool.name)) return tool;
    const scopedConnections = connections.filter(connection => allowed.has(connection.fullName));
    if (!scopedConnections.length) return null;
    return {
        ...tool,
        input_schema: buildDatabaseToolSchema(tool.input_schema, scopedConnections),
        databaseConnections: scopedConnections
    };
}

function buildAgentToolSchemas(toolList) {
    return (toolList || []).filter(tool => tool && tool.name).map(tool => ({
        name: tool.name,
        description: tool.description || tool.title || '',
        input_schema: tool.input_schema || tool.parameters || { type: 'object', properties: {} }
    }));
}

module.exports = {
    buildAgentToolSchemas,
    buildGenericDatabaseTools,
    formatToolList
};
