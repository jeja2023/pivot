const { db } = require('../db');
const { getBeijingTimestamp } = require('../time');
const {
    decryptSecret,
    validateMcpEndpointUrl,
    assertSafeMcpOutboundUrl,
    createSafeHttpAgentsForUser,
    redactSecrets
} = require('../security');
const { safeJsonPost } = require('./safe-http-client');
const {
    executeDatabaseMcpTool,
    getDatabaseConnectionForServer,
    listDatabaseMcpTools
} = require('./database-mcp');
const {
    executeBuiltinMcpTool,
    getBuiltinConfigForServer,
    getBuiltinServiceTypeFromUrl,
    isInternalMcpUrl,
    listBuiltinMcpTools
} = require('./builtin-mcp');
const {
    LOCAL_MCP_SERVER_ID,
    executeLocalDeviceMcpTool,
    getLocalDeviceMcpServerTypeForTool,
    isLocalDeviceMcpServerId,
    listLocalDeviceMcpTools
} = require('./local-device-mcp');
const {
    executeBridgeLocalDeviceMcpTool,
    listBridgeLocalDeviceMcpTools
} = require('./local-device-bridge');
const { isSuperAdmin } = require('../permissions');
const {
    canAccessSharedResource,
    normalizeShareSettings
} = require('./unit-visibility');
const { filterExistingShareUserIds, listShareTargets } = require('./share-targets');
const { enqueueMcpCallLog } = require('./sqlite-write-queue');

const MCP_TIMEOUT_MS = 20000;
const PREVIEW_LIMIT = 1800;
const SHARED_READONLY_DATABASE_TOOLS = new Set([
    'db.list_tables',
    'db.count_tables',
    'db.describe_table',
    'db.run_readonly_query',
    'db.group_count',
    'db.list_collections',
    'db.count_collections',
    'db.sample_collection',
    'db.aggregate'
]);

function isUnitSharedMcpServer(server) {
    return Boolean(server && server.user_id !== null && server.user_id !== undefined && String(server.scope || '').toLowerCase() === 'shared');
}

function isSharedMcpToolAllowed(server, toolName) {
    if (!isUnitSharedMcpServer(server)) return true;
    const baseUrl = server.base_url || server.server_base_url || '';
    if (!String(baseUrl).startsWith('pivot-db://')) return false;
    return SHARED_READONLY_DATABASE_TOOLS.has(String(toolName || ''));
}

function previewValue(value, limit = PREVIEW_LIMIT) {
    // 先脱敏再序列化，避免 api_key / Bearer Token 等敏感字段落入审计日志
    const safeValue = redactSecrets(value);
    let text = '';
    try {
        text = typeof safeValue === 'string' ? safeValue : JSON.stringify(safeValue);
    } catch (e) {
        text = String(safeValue || '');
    }
    return String(text || '').slice(0, limit);
}

function recordMcpCallLog({ user, serverId, toolName, source = 'manual', status = 'success', durationMs = 0, input, output, error }) {
    try {
        enqueueMcpCallLog({
            userId: user?.id || null,
            serverId: isLocalDeviceMcpServerId(serverId) ? null : (serverId ?? null),
            toolName: String(toolName || '').slice(0, 240),
            source: String(source || 'manual').slice(0, 40),
            status: status === 'error' ? 'error' : 'success',
            durationMs: Math.max(Number(durationMs) || 0, 0),
            inputPreview: previewValue(input),
            outputPreview: status === 'error' ? '' : previewValue(output),
            errorMessage: status === 'error' ? String(error?.message || error || '').slice(0, 1000) : '',
            createdAt: getBeijingTimestamp()
        });
    } catch (e) {
        // 审计日志绝不能阻塞工具调用路径。
    }
}

function formatMcpOwner(row = {}) {
    const rawUserId = row.user_id ?? row.owner_id;
    const userId = rawUserId === null || rawUserId === undefined || rawUserId === ''
        ? null
        : Number(rawUserId);
    if (!userId) {
        return {
            id: null,
            username: '',
            nickname: '全局',
            unit: '',
            role: '',
            displayName: '全局',
            scope: 'global'
        };
    }
    const username = String(row.owner_username || row.username || '').trim();
    const nickname = String(row.owner_nickname || row.nickname || '').trim();
    const unit = String(row.owner_unit || row.unit || '').trim();
    const role = String(row.owner_role || row.role || '').trim();
    return {
        id: userId,
        username,
        nickname,
        unit,
        role,
        displayName: nickname || username || `用户 ${userId}`,
        scope: 'user'
    };
}

function normalizeServerRow(row) {
    if (!row) return null;
    let config = {};
    try {
        config = row.config ? JSON.parse(row.config) : {};
    } catch (e) {
        config = {};
    }
    const databaseConnection = String(row.base_url || '').startsWith('pivot-db://')
        ? getDatabaseConnectionForServer(row.id)
        : null;
    const builtinType = getBuiltinServiceTypeFromUrl(row.base_url);
    const builtinConfig = builtinType ? getBuiltinConfigForServer(row.id) : null;
    return {
        id: row.id,
        user_id: row.user_id,
        name: row.name,
        base_url: row.base_url,
        description: row.description || '',
        status: row.status || 'active',
        last_error: row.last_error || '',
        last_checked_at: row.last_checked_at || '',
        created_at: row.created_at,
        updated_at: row.updated_at,
        has_api_key: Boolean(row.api_key),
        scope: row.scope || (row.user_id === null ? 'shared' : 'personal'),
        allowed_units: row.allowed_units || '',
        allowed_user_ids: row.allowed_user_ids || '',
        read_only: isUnitSharedMcpServer(row),
        owner: formatMcpOwner(row),
        config,
        server_type: databaseConnection ? 'database' : (builtinType || 'external'),
        database_connection: databaseConnection,
        builtin_config: builtinConfig
    };
}

function getAccessibleMcpServer(serverId, user) {
    const row = db.prepare(`
        SELECT * FROM mcp_servers
        WHERE id = ? AND status != 'deleted'
          AND (
              user_id IS NULL
              OR user_id = ?
              OR ? = 1
              OR (
                  scope = 'shared'
                  AND (
                      (
                          TRIM(COALESCE(allowed_units, '')) = ''
                          AND TRIM(COALESCE(allowed_user_ids, '')) = ''
                      )
                      OR instr(',' || replace(COALESCE(allowed_units, ''), ' ', '') || ',', ',' || ? || ',') > 0
                      OR instr(',' || replace(COALESCE(allowed_user_ids, ''), ' ', '') || ',', ',' || ? || ',') > 0
                  )
              )
          )
    `).get(serverId, user.id, isSuperAdmin(user) ? 1 : 0, String(user?.unit || '').trim(), user.id);
    if (row?.api_key) row.api_key = decryptSecret(row.api_key);
    return row || null;
}

function listMcpServers(user) {
    const rows = db.prepare(`
        SELECT s.*, COALESCE(NULLIF(u.deleted_username, ''), u.username) AS owner_username, u.nickname AS owner_nickname,
               u.unit AS owner_unit, u.role AS owner_role
        FROM mcp_servers s
        LEFT JOIN users u ON u.id = s.user_id
        WHERE s.status != 'deleted'
          AND (
              s.user_id IS NULL
              OR s.user_id = ?
              OR ? = 1
              OR (
                  s.scope = 'shared'
                  AND (
                      (
                          TRIM(COALESCE(s.allowed_units, '')) = ''
                          AND TRIM(COALESCE(s.allowed_user_ids, '')) = ''
                      )
                      OR instr(',' || replace(COALESCE(s.allowed_units, ''), ' ', '') || ',', ',' || ? || ',') > 0
                      OR instr(',' || replace(COALESCE(s.allowed_user_ids, ''), ' ', '') || ',', ',' || ? || ',') > 0
                  )
              )
          )
        ORDER BY s.user_id IS NOT NULL, s.name ASC
    `).all(user.id, isSuperAdmin(user) ? 1 : 0, String(user?.unit || '').trim(), user.id);
    return rows.map(row => ({
        ...normalizeServerRow(row),
        can_edit: Number(row.user_id) === Number(user?.id) || (row.user_id === null && isSuperAdmin(user)),
        read_only: isUnitSharedMcpServer(row) && Number(row.user_id) !== Number(user?.id)
    }));
}

function getMcpServerShareOptions(serverId, user) {
    const row = db.prepare(`
        SELECT s.*, u.unit AS owner_unit
        FROM mcp_servers s
        LEFT JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.status != 'deleted'
    `).get(serverId);
    if (!row || (Number(row.user_id) !== Number(user?.id) && !isSuperAdmin(user))) return null;
    return {
        server: normalizeServerRow(row),
        ...listShareTargets(user, { excludeUserId: row.user_id }),
        supportsSharing: String(row.base_url || '').startsWith('pivot-db://')
    };
}

function updateMcpServerSharing(serverId, user, body = {}) {
    const row = db.prepare("SELECT * FROM mcp_servers WHERE id = ? AND status != 'deleted'").get(serverId);
    if (!row || (Number(row.user_id) !== Number(user?.id) && !isSuperAdmin(user))) return null;
    if (row.user_id === null) {
        const err = new Error('全局服务不需要单位共享设置。');
        err.status = 400;
        throw err;
    }
    const settings = normalizeShareSettings(body, user, row);
    settings.allowedUserIds = filterExistingShareUserIds(settings.allowedUserIds, { excludeUserId: row.user_id });
    if (settings.scope === 'shared' && row.user_id !== null && !String(row.base_url || '').startsWith('pivot-db://')) {
        const err = new Error('当前阶段仅支持共享只读数据库能力，外部服务和通知服务不能共享。');
        err.status = 400;
        throw err;
    }
    db.prepare(`
        UPDATE mcp_servers
        SET scope = ?, allowed_units = ?, allowed_user_ids = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND status != 'deleted'
    `).run(settings.scope, settings.allowedUnits, settings.allowedUserIds, getBeijingTimestamp(), serverId, row.user_id);
    return getAccessibleMcpServer(serverId, user);
}

async function callMcpJsonRpc(server, method, params = {}, user = null, options = {}) {
    options.signal?.throwIfAborted?.();
    if (String(server.base_url || '').startsWith('pivot-db://')) {
        if (method === 'tools/list') return { tools: listDatabaseMcpTools(server) };
        if (method === 'tools/call') {
            const result = await executeDatabaseMcpTool(server, params?.name, params?.arguments || {});
            options.signal?.throwIfAborted?.();
            return {
                content: [{
                    type: 'text',
                    text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
                }],
                structuredContent: result
            };
        }
        throw new Error(`Unsupported database MCP method: ${method}`);
    }
    if (getBuiltinServiceTypeFromUrl(server.base_url)) {
        if (method === 'tools/list') return { tools: listBuiltinMcpTools(server) };
        if (method === 'tools/call') {
            const result = await executeBuiltinMcpTool(server, params?.name, params?.arguments || {}, user, options);
            options.signal?.throwIfAborted?.();
            return {
                content: [{
                    type: 'text',
                    text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
                }],
                structuredContent: result
            };
        }
        throw new Error(`Unsupported built-in MCP method: ${method}`);
    }

    const url = String(server.base_url || '').trim().replace(/\/+$/, '');
    let config = {};
    try {
        config = server.config ? JSON.parse(server.config) : {};
    } catch (e) {
        config = {};
    }
    const timeoutMs = Math.max(1000, Math.min(Number(config.timeoutMs || config.timeout_ms || MCP_TIMEOUT_MS) || MCP_TIMEOUT_MS, 120000));
    const authMode = String(config.authMode || config.auth_mode || 'auto').toLowerCase();
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Pivot-MCP-Client/1.0'
    };
    if (server.api_key && authMode !== 'none') {
        if (authMode === 'bearer') headers.Authorization = `Bearer ${server.api_key}`;
        else if (authMode === 'x-api-key') headers['x-api-key'] = server.api_key;
        else {
            headers.Authorization = `Bearer ${server.api_key}`;
            headers['x-api-key'] = server.api_key;
        }
    }
    // 调用时再次校验出站地址，拦截 loopback/link-local/云元数据等 SSRF 目标（含 DNS rebinding）。
    const response = await safeJsonPost(url, {
        jsonrpc: '2.0',
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        method,
        params
    }, {
        user,
        assertUrl: (targetUrl, targetUser) => assertSafeMcpOutboundUrl(targetUrl, targetUser),
        createAgents: (targetUser) => createSafeHttpAgentsForUser(targetUser, {
            allowPrivateEnv: 'ALLOW_PRIVATE_MCP_URLS',
            allowExplicitLoopbackForAdmin: true
        }),
        headers,
        timeout: timeoutMs,
        signal: options.signal || null
    });
    if (response.data?.error) {
        throw new Error(response.data.error.message || JSON.stringify(response.data.error));
    }
    return response.data?.result;
}

function upsertToolCache(serverId, tools = []) {
    const clear = db.prepare('DELETE FROM mcp_tool_cache WHERE server_id = ?');
    const insert = db.prepare(`
        INSERT INTO mcp_tool_cache (server_id, name, description, input_schema, cached_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(server_id, name) DO UPDATE SET
            description = excluded.description,
            input_schema = excluded.input_schema,
            cached_at = excluded.cached_at
    `);
    const now = getBeijingTimestamp();
    const tx = db.transaction(() => {
        clear.run(serverId);
        tools.forEach(tool => {
            const name = String(tool.name || '').trim();
            if (!name) return;
            insert.run(
                serverId,
                name,
                String(tool.description || ''),
                JSON.stringify(tool.inputSchema || tool.input_schema || { type: 'object' }),
                now
            );
        });
    });
    tx();
}

async function refreshMcpTools(server, user = null) {
    if (!isInternalMcpUrl(server.base_url)) {
        validateMcpEndpointUrl(server.base_url);
    }
    try {
        const result = await callMcpJsonRpc(server, 'tools/list', {}, user);
        const tools = Array.isArray(result?.tools) ? result.tools : Array.isArray(result) ? result : [];
        let config = {};
        try {
            config = server.config ? JSON.parse(server.config) : {};
        } catch (err) {
            config = {};
        }
        const validateSchema = config.validateToolSchema === true || config.validate_tool_schema === true;
        const normalizedTools = tools.filter(tool => {
            if (!tool?.name) return false;
            if (!validateSchema) return true;
            const schema = tool.inputSchema || tool.input_schema;
            return schema && typeof schema === 'object' && !Array.isArray(schema) && (schema.type === 'object' || schema.properties);
        });
        if (validateSchema && normalizedTools.length !== tools.filter(tool => tool?.name).length) {
            throw new Error('外部工具服务存在工具 Schema 缺失或格式不正确，请修正后再刷新。');
        }
        upsertToolCache(server.id, normalizedTools);
        db.prepare('UPDATE mcp_servers SET last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?')
          .run('', getBeijingTimestamp(), getBeijingTimestamp(), server.id);
        return listCachedMcpTools(server.id, user);
    } catch (e) {
        db.prepare('UPDATE mcp_servers SET last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?')
          .run(e.message, getBeijingTimestamp(), getBeijingTimestamp(), server.id);
        throw e;
    }
}

function listCachedMcpTools(serverId = null, user = null) {
    if (isLocalDeviceMcpServerId(serverId)) {
        const directLocalTools = listLocalDeviceMcpTools(user);
        return directLocalTools.length ? directLocalTools : listBridgeLocalDeviceMcpTools(user);
    }
    if (serverId) {
        return db.prepare(`
            SELECT t.*, s.user_id, s.name AS server_name, s.base_url AS server_base_url,
                   s.scope, s.allowed_units,
                   COALESCE(NULLIF(u.deleted_username, ''), u.username) AS owner_username, u.nickname AS owner_nickname,
                   u.unit AS owner_unit, u.role AS owner_role, c.database_type
            FROM mcp_tool_cache t
            JOIN mcp_servers s ON s.id = t.server_id
            LEFT JOIN users u ON u.id = s.user_id
            LEFT JOIN mcp_database_connections c ON c.mcp_server_id = s.id AND c.status != 'deleted'
            WHERE t.server_id = ? AND s.status != 'deleted'
            ORDER BY t.name ASC
        `).all(serverId).filter(row => isSuperAdmin(user) || canAccessSharedResource(row, user)).filter(row => isSharedMcpToolAllowed(row, row.name)).map(formatMcpTool);
    }
    const rows = db.prepare(`
        SELECT t.*, s.user_id, s.name AS server_name, s.base_url AS server_base_url,
               s.scope, s.allowed_units,
               COALESCE(NULLIF(u.deleted_username, ''), u.username) AS owner_username, u.nickname AS owner_nickname,
               u.unit AS owner_unit, u.role AS owner_role, c.database_type
        FROM mcp_tool_cache t
        JOIN mcp_servers s ON s.id = t.server_id
        LEFT JOIN users u ON u.id = s.user_id
        LEFT JOIN mcp_database_connections c ON c.mcp_server_id = s.id AND c.status != 'deleted'
        WHERE s.status = 'active'
        ORDER BY s.name ASC, t.name ASC
    `).all();
    const directLocalTools = listLocalDeviceMcpTools(user);
    const bridgeLocalTools = directLocalTools.length ? [] : listBridgeLocalDeviceMcpTools(user);
    return [
        ...directLocalTools,
        ...bridgeLocalTools,
        ...rows
            .filter(row => isSuperAdmin(user) || canAccessSharedResource(row, user))
            .filter(row => isSharedMcpToolAllowed(row, row.name))
            .map(formatMcpTool)
    ];
}

function formatMcpTool(row) {
    let schema = { type: 'object' };
    try {
        schema = JSON.parse(row.input_schema || '{}') || schema;
    } catch (e) {}
    const serverBaseUrl = String(row.server_base_url || row.base_url || '');
    const serverType = serverBaseUrl.startsWith('pivot-db://')
        ? 'database'
        : getBuiltinServiceTypeFromUrl(serverBaseUrl) || 'external';
    const packageType = serverType === 'database' ? 'database_connection' : 'mcp_server';
    const { getCapabilityToolGovernance } = require('./capability-market');
    const governance = getCapabilityToolGovernance(packageType, String(row.server_id ?? ''), row.name);
    return {
        serverId: row.server_id,
        serverName: row.server_name,
        serverType,
        databaseType: row.database_type || '',
        owner: formatMcpOwner(row),
        name: row.name,
        fullName: `mcp.${row.server_id}.${row.name}`,
        description: row.description || '',
        input_schema: schema,
        governance,
        cached_at: row.cached_at
    };
}

async function executeMcpTool(fullName, input, user, options = {}) {
    options.signal?.throwIfAborted?.();
    const match = String(fullName || '').match(/^mcp\.(\d+)\.(.+)$/);
    if (!match) throw new Error('Invalid MCP tool name.');
    if (isLocalDeviceMcpServerId(match[1])) {
        const toolName = match[2];
        const serverType = getLocalDeviceMcpServerTypeForTool(toolName);
        if (!serverType) throw new Error('本机工具不可用。');
        const packageType = serverType === 'database' ? 'database_connection' : 'mcp_server';
        const { isToolCapabilityEnabled } = require('./capability-market');
        if (!isToolCapabilityEnabled(packageType, match[1], toolName, user)) {
            const err = new Error('该工具已在工具治理中停用。');
            err.status = 403;
            throw err;
        }
        const startedAt = Date.now();
        try {
            const directLocalTools = listLocalDeviceMcpTools(user);
            const hasDirectLocalTool = directLocalTools.some(tool => tool.name === toolName);
            const result = hasDirectLocalTool
                ? await executeLocalDeviceMcpTool(toolName, input || {}, user)
                : await executeBridgeLocalDeviceMcpTool(toolName, input || {}, user);
            options.signal?.throwIfAborted?.();
            recordMcpCallLog({
                user,
                serverId: LOCAL_MCP_SERVER_ID,
                toolName,
                source: options.source || 'manual',
                status: 'success',
                durationMs: Date.now() - startedAt,
                input,
                output: result
            });
            return {
                content: [{
                    type: 'text',
                    text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
                }],
                structuredContent: result
            };
        } catch (e) {
            recordMcpCallLog({
                user,
                serverId: LOCAL_MCP_SERVER_ID,
                toolName,
                source: options.source || 'manual',
                status: 'error',
                durationMs: Date.now() - startedAt,
                input,
                error: e
            });
            throw e;
        }
    }
    const server = getAccessibleMcpServer(Number(match[1]), user);
    if (!server || server.status !== 'active') throw new Error('MCP server is not available.');
    if (!isSharedMcpToolAllowed(server, match[2])) {
        const err = new Error('共享工具仅允许执行只读数据库能力。');
        err.status = 403;
        throw err;
    }
    const serverType = String(server.base_url || '').startsWith('pivot-db://')
        ? 'database_connection'
        : 'mcp_server';
    const { isToolCapabilityEnabled } = require('./capability-market');
    if (!isToolCapabilityEnabled(serverType, String(server.id), match[2], user)) {
        const err = new Error('该工具已在工具治理中停用。');
        err.status = 403;
        throw err;
    }
    if (!isInternalMcpUrl(server.base_url)) {
        validateMcpEndpointUrl(server.base_url);
    }
    const startedAt = Date.now();
    try {
        const result = await callMcpJsonRpc(server, 'tools/call', {
            name: match[2],
            arguments: input || {}
        }, user, options);
        recordMcpCallLog({
            user,
            serverId: server.id,
            toolName: match[2],
            source: options.source || 'manual',
            status: 'success',
            durationMs: Date.now() - startedAt,
            input,
            output: result
        });
        return result;
    } catch (e) {
        recordMcpCallLog({
            user,
            serverId: server.id,
            toolName: match[2],
            source: options.source || 'manual',
            status: 'error',
            durationMs: Date.now() - startedAt,
            input,
            error: e
        });
        throw e;
    }
}

module.exports = {
    executeMcpTool,
    getAccessibleMcpServer,
    listCachedMcpTools,
    listMcpServers,
    getMcpServerShareOptions,
    updateMcpServerSharing,
    normalizeServerRow,
    recordMcpCallLog,
    refreshMcpTools
};
