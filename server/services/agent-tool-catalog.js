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

function formatToolList(user, options = {}) {
    const policy = normalizeToolPolicy(options.toolPolicy);
    const allowlist = normalizeToolAllowlist(options.toolAllowlist);
    const allowed = allowlist.length ? new Set(allowlist) : null;
    const isAllowed = (name, source) => {
        if (policy === 'builtin_only' && source === 'mcp') return false;
        if (allowed && !allowed.has(name)) return false;
        return true;
    };
    const builtIns = filterBuiltInToolsByCapability(getBuiltInToolDefinitions(user), user).map(tool => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        input_schema: tool.input_schema,
        source: 'builtin',
        risk: 'low',
        requiresApproval: false,
        admin: Boolean(tool.admin)
    })).filter(tool => isAllowed(tool.name, 'builtin'));
    // 内置工具已统一提供 viz.build_chart 等能力；当用户另外添加了系统可视化等内置 MCP 服务时，
    // 缓存的工具名（如 viz.build_chart）会与内置工具同名而在目录中重复。这里按裸工具名去重，
    // 同名时只保留内置工具，避免工作流工具选择器出现重复项（外部 MCP 工具名带服务前缀，不受影响）。
    const builtinToolNames = new Set(builtIns.map(tool => tool.name));
    const mcpTools = filterMcpToolsByCapability(listCachedMcpTools(null, user), user)
        .filter(tool => !builtinToolNames.has(String(tool.name || '')))
        .map(tool => ({
            name: tool.fullName,
            title: tool.name,
            description: `[${tool.serverName}] ${tool.description || tool.name}`,
            input_schema: tool.input_schema,
            source: 'mcp',
            risk: String(tool.name || '').startsWith('db.') ? 'low' : 'high',
            requiresApproval: !String(tool.name || '').startsWith('db.'),
            serverName: tool.serverName
        }))
        .filter(tool => isAllowed(tool.name, 'mcp'));
    return [...builtIns, ...mcpTools];
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
    formatToolList
};
