const express = require('express');
const { db } = require('../db');
const { asyncHandler } = require('../http');
const { getBeijingTimestamp } = require('../time');
const { decryptSecret, encryptSecret, validateModelUrl } = require('../security');
const { getSystemHealthSnapshot } = require('../services/system-health');
const { debugRetrieveContext } = require('../services/rag-index');
const {
    executeMcpTool,
    getAccessibleMcpServer,
    listCachedMcpTools,
    listMcpServers,
    normalizeServerRow,
    refreshMcpTools
} = require('../services/mcp-client');
const { getBuiltInToolDefinitions, executeBuiltInTool } = require('../services/agent-tools');
const {
    DEFAULT_PORTS,
    testDatabaseConnection,
    validateDatabaseConnectionPayload
} = require('../services/database-mcp');
const isSuperAdmin = (user) => user?.username === 'admin';

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

    router.get('/mcp/servers', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: listMcpServers(req.user) });
    }));

    router.get('/mcp/database-types', authMiddleware, asyncHandler(async (_req, res) => {
        res.json({
            data: [
                { id: 'postgres', name: 'PostgreSQL', defaultPort: DEFAULT_PORTS.postgres, driver: 'pg' },
                { id: 'mysql', name: 'MySQL / MariaDB', defaultPort: DEFAULT_PORTS.mysql, driver: 'mysql2' },
                { id: 'sqlserver', name: 'SQL Server', defaultPort: DEFAULT_PORTS.sqlserver, driver: 'mssql' },
                { id: 'sqlite', name: 'SQLite', defaultPort: DEFAULT_PORTS.sqlite, driver: 'better-sqlite3' },
                { id: 'mongodb', name: 'MongoDB', defaultPort: DEFAULT_PORTS.mongodb, driver: 'mongodb' }
            ]
        });
    }));

    router.post('/mcp/database-connections/test', authMiddleware, asyncHandler(async (req, res) => {
        const serverId = req.body?.id || req.body?.mcp_server_id || req.body?.mcpServerId;
        let password = req.body?.password;

        if (serverId) {
            const existing = getAccessibleMcpServer(serverId, req.user);
            if (!existing) return res.status(404).json({ error: 'MCP server not found.' });
            if (!String(existing.base_url || '').startsWith('pivot-db://')) {
                return res.status(400).json({ error: '该 MCP 服务不是数据库预设。' });
            }
            const dbConnectionRow = db.prepare('SELECT * FROM mcp_database_connections WHERE mcp_server_id = ?').get(existing.id);
            if (!dbConnectionRow) return res.status(404).json({ error: '数据库连接配置不存在。' });
            if (password === undefined || password === '********') {
                password = decryptExistingDatabasePassword(dbConnectionRow);
            }
        }

        const connection = validateDatabaseConnectionPayload({ ...req.body, password }, req.user);
        const result = await testDatabaseConnection(connection);
        logAction(req, '测试数据库 MCP 连接', `${connection.database_type}: ${connection.host || connection.database_name}`);
        res.json({ success: true, result });
    }));

    router.post('/mcp/servers', authMiddleware, asyncHandler(async (req, res) => {
        const name = String(req.body?.name || '').trim();
        const baseUrl = String(req.body?.base_url || req.body?.baseUrl || '').trim();
        const apiKey = String(req.body?.api_key || req.body?.apiKey || '').trim();
        const description = String(req.body?.description || '').trim();
        const shared = isSuperAdmin(req.user) && (req.body?.shared === true || req.body?.user_id === null);
        if (!name || !baseUrl) return res.status(400).json({ error: 'Name and Base URL are required.' });
        validateModelUrl(baseUrl, req.user);
        const now = getBeijingTimestamp();
        const info = db.prepare(`
            INSERT INTO mcp_servers (user_id, name, base_url, api_key, description, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        `).run(shared ? null : req.user.id, name, baseUrl, encryptSecret(apiKey), description, now, now);
        logAction(req, '新增 MCP 服务', `${name}: ${baseUrl}`);
        res.status(201).json({ success: true, server: normalizeServerRow(db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(info.lastInsertRowid)) });
    }));

    router.post('/mcp/database-connections', authMiddleware, asyncHandler(async (req, res) => {
        const name = String(req.body?.name || '').trim();
        const description = String(req.body?.description || '').trim();
        const shared = isSuperAdmin(req.user) && (req.body?.shared === true || req.body?.user_id === null);
        if (!name) return res.status(400).json({ error: '请填写连接名称。' });

        const connection = validateDatabaseConnectionPayload(req.body, req.user);
        const now = getBeijingTimestamp();
        const userId = shared ? null : req.user.id;
        const tx = db.transaction(() => {
            const info = db.prepare(`
                INSERT INTO mcp_servers (user_id, name, base_url, api_key, description, status, created_at, updated_at)
                VALUES (?, ?, ?, '', ?, 'active', ?, ?)
            `).run(userId, name, 'pivot-db://pending', description, now, now);
            const serverId = info.lastInsertRowid;
            db.prepare('UPDATE mcp_servers SET base_url = ? WHERE id = ?')
              .run(`pivot-db://connection/${serverId}`, serverId);
            db.prepare(`
                INSERT INTO mcp_database_connections (
                    mcp_server_id, user_id, database_type, host, port, database_name, username, password, options, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
            `).run(
                serverId,
                userId,
                connection.database_type,
                connection.host,
                connection.port,
                connection.database_name,
                connection.username,
                encryptSecret(connection.password),
                JSON.stringify(connection.options),
                now,
                now
            );
            return serverId;
        });
        const serverId = tx();
        logAction(req, '新增数据库 MCP 服务', `${name}: ${connection.database_type}`);
        res.status(201).json({ success: true, server: normalizeServerRow(db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(serverId)) });
    }));

    router.put('/mcp/database-connections/:id', authMiddleware, asyncHandler(async (req, res) => {
        const existing = getAccessibleMcpServer(req.params.id, req.user);
        if (!existing) return res.status(404).json({ error: 'MCP server not found.' });
        if (!String(existing.base_url || '').startsWith('pivot-db://')) return res.status(400).json({ error: '该 MCP 服务不是数据库预设。' });
        if (existing.user_id === null && !isSuperAdmin(req.user)) return res.status(403).json({ error: '只有 admin 超级管理员可以编辑全局 MCP 服务。' });
        if (existing.user_id !== null && existing.user_id !== req.user.id && !isSuperAdmin(req.user)) return res.status(403).json({ error: '无权编辑该 MCP 服务。' });

        const dbConnectionRow = db.prepare('SELECT * FROM mcp_database_connections WHERE mcp_server_id = ?').get(existing.id);
        if (!dbConnectionRow) return res.status(404).json({ error: '数据库连接配置不存在。' });

        const name = String(req.body?.name || existing.name).trim();
        const description = String(req.body?.description ?? existing.description ?? '').trim();
        const status = ['active', 'paused'].includes(req.body?.status) ? req.body.status : existing.status;
        const connection = validateDatabaseConnectionPayload({
            ...req.body,
            password: req.body?.password === undefined || req.body?.password === '********'
                ? decryptExistingDatabasePassword(dbConnectionRow)
                : req.body?.password
        }, req.user);
        const now = getBeijingTimestamp();
        db.transaction(() => {
            db.prepare(`
                UPDATE mcp_servers
                SET name = ?, description = ?, status = ?, updated_at = ?
                WHERE id = ?
            `).run(name, description, status, now, existing.id);
            db.prepare(`
                UPDATE mcp_database_connections
                SET database_type = ?, host = ?, port = ?, database_name = ?, username = ?, password = ?, options = ?, status = ?, updated_at = ?
                WHERE mcp_server_id = ?
            `).run(
                connection.database_type,
                connection.host,
                connection.port,
                connection.database_name,
                connection.username,
                encryptSecret(connection.password),
                JSON.stringify(connection.options),
                status,
                now,
                existing.id
            );
        })();
        logAction(req, '修改数据库 MCP 服务', `${name}: ${connection.database_type}`);
        res.json({ success: true, server: normalizeServerRow(db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(existing.id)) });
    }));

    router.put('/mcp/servers/:id', authMiddleware, asyncHandler(async (req, res) => {
        const existing = getAccessibleMcpServer(req.params.id, req.user);
        if (!existing) return res.status(404).json({ error: 'MCP server not found.' });
        if (String(existing.base_url || '').startsWith('pivot-db://')) return res.status(400).json({ error: '数据库预设请使用数据库连接表单编辑。' });
        if (existing.user_id === null && !isSuperAdmin(req.user)) return res.status(403).json({ error: '只有 admin 超级管理员可以编辑全局 MCP 服务。' });
        if (existing.user_id !== null && existing.user_id !== req.user.id && !isSuperAdmin(req.user)) return res.status(403).json({ error: '无权编辑该 MCP 服务。' });

        const name = String(req.body?.name || existing.name).trim();
        const baseUrl = String(req.body?.base_url || req.body?.baseUrl || existing.base_url).trim();
        const description = String(req.body?.description ?? existing.description ?? '').trim();
        const status = ['active', 'paused'].includes(req.body?.status) ? req.body.status : existing.status;
        const apiKeyInput = req.body?.api_key ?? req.body?.apiKey;
        const nextApiKey = apiKeyInput === undefined || apiKeyInput === '********'
            ? encryptSecret(existing.api_key || '')
            : encryptSecret(String(apiKeyInput || '').trim());
        validateModelUrl(baseUrl, req.user);
        db.prepare(`
            UPDATE mcp_servers
            SET name = ?, base_url = ?, api_key = ?, description = ?, status = ?, updated_at = ?
            WHERE id = ?
        `).run(name, baseUrl, nextApiKey, description, status, getBeijingTimestamp(), existing.id);
        logAction(req, '修改 MCP 服务', `${name}: ${baseUrl}`);
        res.json({ success: true, server: normalizeServerRow(db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(existing.id)) });
    }));

    router.delete('/mcp/servers/:id', authMiddleware, asyncHandler(async (req, res) => {
        const existing = getAccessibleMcpServer(req.params.id, req.user);
        if (!existing) return res.status(404).json({ error: 'MCP server not found.' });
        if (existing.user_id === null && !isSuperAdmin(req.user)) return res.status(403).json({ error: '只有 admin 超级管理员可以删除全局 MCP 服务。' });
        if (existing.user_id !== null && existing.user_id !== req.user.id && !isSuperAdmin(req.user)) return res.status(403).json({ error: '无权删除该 MCP 服务。' });
        const now = getBeijingTimestamp();
        db.prepare("UPDATE mcp_servers SET status = 'deleted', updated_at = ? WHERE id = ?").run(now, existing.id);
        db.prepare("UPDATE mcp_database_connections SET status = 'deleted', updated_at = ? WHERE mcp_server_id = ?").run(now, existing.id);
        logAction(req, '删除 MCP 服务', existing.name);
        res.json({ success: true });
    }));

    router.post('/mcp/servers/:id/refresh', authMiddleware, asyncHandler(async (req, res) => {
        const server = getAccessibleMcpServer(req.params.id, req.user);
        if (!server) return res.status(404).json({ error: 'MCP server not found.' });
        const tools = await refreshMcpTools(server, req.user);
        logAction(req, '刷新 MCP 工具', `${server.name}: ${tools.length}`);
        res.json({ success: true, tools });
    }));

    router.get('/mcp/tools', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ tools: listCachedMcpTools(null, req.user) });
    }));

    router.post('/mcp/tools/call', authMiddleware, asyncHandler(async (req, res) => {
        const name = String(req.body?.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Tool name is required.' });
        const result = name.startsWith('mcp.')
            ? await executeMcpTool(name, req.body?.input || {}, req.user)
            : await executeBuiltInTool(name, req.body?.input || {}, req.user);
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
                return sendJsonRpc(res, id, {
                    tools: getBuiltInToolDefinitions(req.user).map(tool => ({
                        name: tool.name,
                        description: tool.description,
                        inputSchema: tool.input_schema
                    }))
                });
            }
            if (method === 'tools/call') {
                const result = await executeBuiltInTool(params?.name, params?.arguments || {}, req.user);
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
                    if (!isSuperAdmin(req.user)) throw new Error('Only admin super administrator can read system health.');
                    return sendJsonRpc(res, id, {
                        contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify(getSystemHealthSnapshot(), null, 2) }]
                    });
                }
                if (params?.uri === 'pivot://knowledge/search') {
                    const result = await debugRetrieveContext(req.user.id, String(params?.query || ''), {});
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
        const rows = db.prepare("SELECT * FROM mcp_servers WHERE status != 'deleted' ORDER BY created_at DESC").all();
        res.json({ data: rows.map(normalizeServerRow) });
    }));

    return router;
}

module.exports = { createMcpRouter };
