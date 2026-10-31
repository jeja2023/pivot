'use strict';

const { toolMatchesAllowlist } = require('./agent-tool-identities');

// @ 只引用当前账号可见的真实目录；不接受模型猜测的名称或客户端提供的端点。
async function resolveChatSelectedTools(user, overrides = {}, manualAllowlist = null, deps = {}) {
    const names = [...new Set((Array.isArray(overrides.tools) ? overrides.tools : [])
        .map(String).filter(name => /^mcp\.\d+\.[A-Za-z0-9_.-]{1,180}$/.test(name)))];
    if (!names.length || overrides.excludeTools === true) return { names: [], tools: [], origins: [], ports: [] };
    if (names.some(name => (Array.isArray(manualAllowlist) && !manualAllowlist.includes(name)) || overrides.excludedTools?.includes(name))) {
        throw new Error('所选工具不在当前会话允许范围内，请检查工具选择。');
    }
    const list = deps.formatToolList || require('./agent-tool-catalog').formatToolList;
    let catalog = await list(user, { toolPolicy: 'all', toolAllowlist: names });
    const executionNames = [...names];
    const missing = names.filter(name => !catalog.some(tool => toolMatchesAllowlist(tool, [name], {}, true)));
    if (missing.length) {
        const raw = await (deps.listCachedMcpTools || require('./mcp-client').listCachedMcpTools)(null, user);
        const visible = await (deps.filterMcpToolsByCapability || require('./capability-market').filterMcpToolsByCapability)(raw, user);
        const builtin = await list(user, { toolPolicy: 'builtin_only' });
        for (const name of missing) {
            const alias = visible.find(tool => tool.fullName === name && tool.serverType !== 'external' && tool.serverType !== 'database');
            const target = alias && builtin.find(tool => tool.source === 'builtin' && tool.name === alias.name);
            if (target) { executionNames[executionNames.indexOf(name)] = target.name; catalog.push(target); }
        }
    }
    const tools = catalog.filter(tool => toolMatchesAllowlist(tool, executionNames, {}, true));
    if (executionNames.some(name => !tools.some(tool => toolMatchesAllowlist(tool, [name], {}, true)))) {
        throw new Error('所选工具不存在或当前账号无权使用，请刷新工具目录。');
    }
    const getServer = deps.getAccessibleMcpServer || require('./mcp-client').getAccessibleMcpServer;
    const origins = new Set();
    const ports = new Set();
    for (const serverId of new Set(names.map(name => Number(name.split('.')[1])).filter(Boolean))) {
        const server = await getServer(serverId, user);
        if (!server || server.status !== 'active') throw new Error('所选工具服务不可用，请刷新工具目录。');
        let endpoint;
        try { endpoint = new URL(server.base_url); } catch (_) { throw new Error('所选工具服务地址无效。'); }
        if (endpoint.username || endpoint.password) throw new Error('所选工具服务地址无效。');
        // 数据库、内置服务与本机连接器仍由各自的执行器检查访问范围。
        if (!['http:', 'https:'].includes(endpoint.protocol)) continue;
        origins.add(endpoint.origin);
        ports.add(Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)));
    }
    return { names, executionNames, tools, origins: [...origins], ports: [...ports] };
}

// 无 @ 时只绑定既有委托能力覆盖的可见工具端点，不能由模型或工具输出指定 URL。
async function resolveAutomaticMcpEndpoints(user, capabilities, manualAllowlist = null, deps = {}) {
    const { capabilitiesCoverTool } = require('./agent-capability-registry');
    const list = deps.formatToolList || require('./agent-tool-catalog').formatToolList;
    const getServer = deps.getAccessibleMcpServer || require('./mcp-client').getAccessibleMcpServer;
    const tools = await list(user, { toolPolicy: 'all', toolAllowlist: manualAllowlist?.length === 0 ? ['__none__'] : manualAllowlist });
    const endpoints = {};
    const servers = new Map();
    for (const tool of tools) {
        if (tool.source !== 'mcp' || !/^mcp\.[1-9]\d*\./.test(tool.name) || !tool.capabilities?.length
            || !tool.capabilities.every(cap => capabilitiesCoverTool(capabilities, [cap]))) continue;
        const id = Number(tool.name.split('.')[1]);
        if (!servers.has(id)) servers.set(id, await getServer(id, user));
        const server = servers.get(id);
        if (server?.status !== 'active') continue;
        let url;
        try { url = new URL(server.base_url); } catch (_) { continue; }
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) endpoints[tool.name] = url.href.replace(/\/+$/, '');
    }
    return endpoints;
}

module.exports = { resolveChatSelectedTools, resolveAutomaticMcpEndpoints };
