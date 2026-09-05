const express = require('express');
const { query, queryOne, execute, transaction } = require('../../db/client');
const { nowOffsetExpr } = require('../../db/dialect');
const { asyncHandler } = require('../../http');
const { getBeijingTimestamp } = require('../../time');
const {
    decryptSecret,
    encryptSecret,
    assertSafeMcpOutboundUrl
} = require('../../security');
const { getSystemHealthSnapshot } = require('../../services/system-health');
const { safeJsonGet } = require('../../services/safe-http-client');
const { debugRetrieveContext } = require('../../services/rag-index');
const {
    executeMcpTool,
    recordMcpCallLog,
    getAccessibleMcpServer,
    listCachedMcpTools,
    listMcpServers,
    getMcpServerShareOptions,
    normalizeServerRowAsync,
    refreshMcpTools,
    updateMcpServerSharing
} = require('../../services/mcp-client');
const { getBuiltInToolDefinitions, executeBuiltInTool } = require('../../services/agent-tools');
const {
    filterBuiltInToolsByCapability,
    filterMcpToolsByCapability,
    getCapabilityToolGovernanceFromPackage,
    getGlobalCapabilityPackage,
    isToolCapabilityEnabled,
    isCapabilityEnabled,
    listGlobalCapabilityPackages,
    setGlobalCapabilityPackageStatus,
    setGlobalCapabilityToolGovernance
} = require('../../services/capability-market');
const {
    DEFAULT_PORTS,
    normalizeDatabaseConnectionError,
    testDatabaseConnection,
    validateDatabaseConnectionPayload
} = require('../../services/database-mcp');
const {
    BUILTIN_MCP_PREFIXES,
    executeBuiltinMcpTool,
    getBuiltinServiceTypeFromUrl,
    getBuiltinConfigForServerAsync,
    normalizeBuiltinPayload
} = require('../../services/builtin-mcp');
const { isSuperAdmin } = require('../../permissions');
const { MCP_CHAT_TOOL_TITLES } = require('../../services/chat-mcp-context');
const {
    SYSTEM_MCP_SERVICES,
    getDatabaseTestErrorStatus,
    sanitizeDatabaseConnectionForLog,
    parseServerConfig,
    parseBoolean,
    normalizeExternalServerConfig,
    buildCapabilityHealth,
    findAccessibleBuiltinService
} = require('./helpers');
const { mountLocalConnectorRoutes } = require('./local-connector');
const { mountMcpManagementRoutes } = require('./management-routes');
const { mountMcpConfigurationRoutes } = require('./configuration-routes');

async function createSystemBuiltinService(serviceType, user) {
    const definition = SYSTEM_MCP_SERVICES[serviceType];
    if (!definition) {
        const err = new Error('不支持的系统工具。');
        err.status = 400;
        throw err;
    }
    if (definition.requiresConfig) {
        const err = new Error('该系统工具需要配置后才能启用。');
        err.status = 400;
        throw err;
    }
    const service = normalizeBuiltinPayload(serviceType, {});
    const now = getBeijingTimestamp();
    const userId = isSuperAdmin(user) ? null : user.id;
    let serverId = 0;
    await transaction(async trx => {
        const info = await trx.queryOne(`
            INSERT INTO mcp_servers (user_id, name, base_url, api_key, description, status, created_at, updated_at)
            VALUES (?, ?, ?, '', ?, 'active', ?, ?)
            RETURNING id
        `, [userId, definition.name, `${BUILTIN_MCP_PREFIXES[service.serviceType]}pending`, definition.description, now, now]);
        serverId = info?.id;
        await trx.execute('UPDATE mcp_servers SET base_url = ? WHERE id = ?', [
            `${BUILTIN_MCP_PREFIXES[service.serviceType]}system/${serverId}`, serverId
        ]);
        await trx.execute(`
            INSERT INTO mcp_builtin_configs (
                mcp_server_id, user_id, service_type, config, secret, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, '', 'active', ?, ?)
        `, [serverId, userId, service.serviceType, JSON.stringify(service.config), now, now]);
    });
    return serverId;
}

function decryptExistingDatabasePassword(row) {
    return decryptSecret(row?.password || '');
}

function sendJsonRpc(res, id, result, error = null) {
    if (error) {
        return res.json({
            jsonrpc: '2.0',
            id: id ?? null,
            error: {
                code: error.code || -32000,
                message: error.message || String(error)
            }
        });
    }
    return res.json({ jsonrpc: '2.0', id: id ?? null, result });
}

function createMcpRouter({ authMiddleware, adminMiddleware, logAction }) {
    const router = express.Router();
    mountLocalConnectorRoutes(router, authMiddleware);
    router.post('/mcp/local-device/heartbeat', authMiddleware, asyncHandler(async (req, res) => {
        res.status(410).json({ error: '旧本机 MCP 内存桥接已下线，请升级至桌面连接器 v2。', code: 'LOCAL_CONNECTOR_V2_REQUIRED' });
    }));


    router.get('/mcp/local-device/status', authMiddleware, asyncHandler(async (req, res) => {
        res.status(410).json({ error: '旧本机 MCP 内存桥接已下线，请使用 /connector/status。', code: 'LOCAL_CONNECTOR_V2_REQUIRED' });
    }));

    router.get('/mcp/local-device/tasks/next', authMiddleware, asyncHandler(async (req, res) => {
        res.status(410).json({ error: '旧本机 MCP 内存任务队列已下线，请使用桌面连接器 v2。', code: 'LOCAL_CONNECTOR_V2_REQUIRED' });
    }));

    router.post('/mcp/local-device/tasks/:id/result', authMiddleware, asyncHandler(async (req, res) => {
        res.status(410).json({ error: '旧本机 MCP 内存任务队列已下线，请使用桌面连接器 v2。', code: 'LOCAL_CONNECTOR_V2_REQUIRED' });
    }));

    mountMcpManagementRoutes({
        router,
        authMiddleware,
        adminMiddleware,
        logAction,
        asyncHandler,
        query,
        queryOne,
        nowOffsetExpr,
        isSuperAdmin,
        listMcpServers,
        getMcpServerShareOptions,
        updateMcpServerSharing,
        normalizeServerRowAsync,
        buildCapabilityHealth,
        getBuiltInToolDefinitions,
        getCapabilityToolGovernanceFromPackage,
        listCachedMcpTools,
        MCP_CHAT_TOOL_TITLES,
        listGlobalCapabilityPackages,
        getGlobalCapabilityPackage,
        setGlobalCapabilityPackageStatus,
        setGlobalCapabilityToolGovernance,
        parseBoolean
    });

    mountMcpConfigurationRoutes({
        router,
        authMiddleware,
        asyncHandler,
        getBeijingTimestamp,
        query,
        queryOne,
        execute,
        transaction,
        decryptSecret,
        encryptSecret,
        assertSafeMcpOutboundUrl,
        getAccessibleMcpServer,
        normalizeServerRowAsync,
        refreshMcpTools,
        listCachedMcpTools,
        filterMcpToolsByCapability,
        DEFAULT_PORTS,
        normalizeDatabaseConnectionError,
        testDatabaseConnection,
        validateDatabaseConnectionPayload,
        BUILTIN_MCP_PREFIXES,
        executeBuiltinMcpTool,
        getBuiltinServiceTypeFromUrl,
        getBuiltinConfigForServerAsync,
        normalizeBuiltinPayload,
        isSuperAdmin,
        SYSTEM_MCP_SERVICES,
        getDatabaseTestErrorStatus,
        sanitizeDatabaseConnectionForLog,
        parseServerConfig,
        normalizeExternalServerConfig,
        findAccessibleBuiltinService,
        safeJsonGet,
        logAction,
        createSystemBuiltinService,
        decryptExistingDatabasePassword
    });

    router.get('/mcp/servers/:id/tools', authMiddleware, asyncHandler(async (req, res) => {
        if (String(req.params.id) === '0') {
            return res.json({ tools: await filterMcpToolsByCapability(await listCachedMcpTools(0, req.user), req.user) });
        }
        const server = await getAccessibleMcpServer(req.params.id, req.user);
        if (!server) return res.status(404).json({ error: '工具服务不存在。' });
        const allTools = await listCachedMcpTools(server.id, req.user);
        res.json({ tools: allTools });
    }));

    router.get('/mcp/tools', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ tools: await filterMcpToolsByCapability(await listCachedMcpTools(null, req.user), req.user) });
    }));

    router.post('/mcp/tools/call', authMiddleware, asyncHandler(async (req, res) => {
        const name = String(req.body?.name || '').trim();
        if (!name) return res.status(400).json({ error: '工具名称为必填项。' });
        if (name.startsWith('mcp.')) {
            const cachedList = await listCachedMcpTools(null, req.user);
            const cached = cachedList.find(tool => tool.fullName === name);
            const sourceRef = cached
                ? String(cached.serverId ?? cached.server_id ?? cached.serverName ?? '')
                : '';
            const type = cached?.serverType === 'database'
                ? 'database_connection'
                : 'mcp_server';
            if (sourceRef && !(await isCapabilityEnabled(type, sourceRef, req.user))) {
                return res.status(403).json({ error: '该工具包已停用。' });
            }
            if (sourceRef && !(await isToolCapabilityEnabled(type, sourceRef, cached?.name || '', req.user))) {
                return res.status(403).json({ error: '该工具已在工具治理中停用。' });
            }
        } else if (!(await isCapabilityEnabled('builtin_tool', name, req.user))) {
            return res.status(403).json({ error: '该系统工具包已停用。' });
        } else if (!(await isToolCapabilityEnabled('builtin_tool', name, name, req.user))) {
            return res.status(403).json({ error: '该系统工具已在工具治理中停用。' });
        }
        const startedAt = Date.now();
        let result;
        try {
            result = name.startsWith('mcp.')
                ? await executeMcpTool(name, req.body?.input || {}, req.user)
                : await executeBuiltInTool(name, req.body?.input || {}, req.user);
            if (!name.startsWith('mcp.')) {
                recordMcpCallLog({ user: req.user, serverId: null, toolName: name, source: 'manual', durationMs: Date.now() - startedAt, input: req.body?.input, output: result });
            }
        } catch (error) {
            if (!name.startsWith('mcp.')) {
                recordMcpCallLog({ user: req.user, serverId: null, toolName: name, source: 'manual', status: 'error', durationMs: Date.now() - startedAt, input: req.body?.input, error });
            }
            throw error;
        }
        logAction(req, '调用工具', name);
        res.json({ success: true, result });
    }));

    router.post('/mcp/rpc', authMiddleware, asyncHandler(async (req, res) => {
        const { id, method, params } = req.body || {};
        try {
            if (method === 'initialize') {
                return sendJsonRpc(res, id, {
                    protocolVersion: '2024-11-05',
                    serverInfo: { name: 'Pivot MCP', version: '1.0.0' },
                    capabilities: { tools: {}, resources: {} }
                });
            }
            if (method === 'tools/list') {
                const builtIns = await filterBuiltInToolsByCapability(getBuiltInToolDefinitions(req.user), req.user);
                return sendJsonRpc(res, id, {
                    tools: builtIns.map(tool => ({
                        name: tool.name,
                        description: tool.description,
                        inputSchema: tool.input_schema
                    }))
                });
            }
            if (method === 'tools/call') {
                if (!(await isCapabilityEnabled('builtin_tool', params?.name, req.user))) {
                    throw new Error('该系统工具包已停用。');
                }
                if (!(await isToolCapabilityEnabled('builtin_tool', params?.name, params?.name, req.user))) {
                    throw new Error('该系统工具已在工具治理中停用。');
                }
                const startedAt = Date.now();
                let result;
                try {
                    result = await executeBuiltInTool(params?.name, params?.arguments || {}, req.user);
                    recordMcpCallLog({ user: req.user, serverId: null, toolName: params?.name, source: 'rpc', durationMs: Date.now() - startedAt, input: params?.arguments, output: result });
                } catch (error) {
                    recordMcpCallLog({ user: req.user, serverId: null, toolName: params?.name, source: 'rpc', status: 'error', durationMs: Date.now() - startedAt, input: params?.arguments, error });
                    throw error;
                }
                return sendJsonRpc(res, id, {
                    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
                });
            }
            if (method === 'resources/list') {
                return sendJsonRpc(res, id, {
                    resources: [
                        { uri: 'pivot://system/health', name: 'System Health', mimeType: 'application/json' },
                        { uri: 'pivot://knowledge/search', name: 'Knowledge Search', mimeType: 'application/json' }
                    ]
                });
            }
            if (method === 'resources/read') {
                if (params?.uri === 'pivot://system/health') {
                    if (!isSuperAdmin(req.user)) throw new Error('仅系统超级管理员可查看系统健康状态。');
                    return sendJsonRpc(res, id, {
                        contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify(getSystemHealthSnapshot(), null, 2) }]
                    });
                }
                if (params?.uri === 'pivot://knowledge/search') {
                    const result = await debugRetrieveContext(req.user.id, String(params?.query || ''), { user: req.user });
                    return sendJsonRpc(res, id, {
                        contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify(result, null, 2) }]
                    });
                }
            }
            return sendJsonRpc(res, id, null, { code: -32601, message: `Unsupported method: ${method}` });
        } catch (e) {
            return sendJsonRpc(res, id, null, e);
        }
    }));

    router.get('/admin/mcp/servers', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const rows = await query("SELECT * FROM mcp_servers WHERE status != 'deleted' ORDER BY created_at DESC");
        res.json({ data: await Promise.all(rows.map(normalizeServerRowAsync)) });
    }));

    return router;
}

module.exports = { createMcpRouter };
