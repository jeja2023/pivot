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
    const mcpTools = filterMcpToolsByCapability(listCachedMcpTools(null, user), user).map(tool => ({
        name: tool.fullName,
        title: tool.name,
        description: `[${tool.serverName}] ${tool.description || tool.name}`,
        input_schema: tool.input_schema,
        source: 'mcp',
        risk: String(tool.name || '').startsWith('db.') ? 'low' : 'high',
        requiresApproval: !String(tool.name || '').startsWith('db.'),
        serverName: tool.serverName
    })).filter(tool => isAllowed(tool.name, 'mcp'));
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
