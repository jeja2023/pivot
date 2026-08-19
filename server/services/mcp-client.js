const { query, queryOne, execute, transaction } = require('../db/client');
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
    listDatabaseMcpTools,
    normalizeDatabaseConnection
} = require('./database-mcp');
const {
    executeBuiltinMcpTool,
    getBuiltinConfigForServer,
    getBuiltinServiceTypeFromUrl,
    isInternalMcpUrl,
    listBuiltinMcpTools
} = require('./builtin-mcp');
const { normalizeBuiltinConfigRow } = require('./builtin-mcp-common');
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
const { enqueueMcpCallLog } = require('./db-write-queue');

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
        config = row.config ? (typeof row.config === 'object' ? row.config : JSON.parse(row.config)) : {};
    } catch (e) {
        config = {};
    }

    let databaseConnection = null;
    if (row.db_conn_id) {
        databaseConnection = normalizeDatabaseConnection({
            id: row.db_conn_id,
            mcp_server_id: row.id,
            database_type: row.db_conn_type,
            database_name: row.db_conn_name,
            host: row.db_conn_host,
            port: row.db_conn_port,
            username: row.db_conn_username,
            password: row.db_conn_password,
            options: row.db_conn_options,
            status: row.db_conn_status,
            updated_at: row.db_conn_updated_at
        }, { includeSecret: false });
    } else if (String(row.base_url || '').startsWith('pivot-db://')) {
        databaseConnection = getDatabaseConnectionForServer(row.id);
    }

    const builtinType = getBuiltinServiceTypeFromUrl(row.base_url);
    let builtinConfig = null;
    if (row.builtin_id) {
        builtinConfig = normalizeBuiltinConfigRow({
            id: row.builtin_id,
            mcp_server_id: row.id,
            service_type: row.builtin_service_type,
            config: row.builtin_config_json,
            secret: row.builtin_secret,
            status: row.builtin_status,
            updated_at: row.builtin_updated_at
        }, { includeSecret: false });
    } else if (builtinType) {
        builtinConfig = getBuiltinConfigForServer(row.id);
    }

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

async function getAccessibleMcpServer(serverId, user) {
    const row = await queryOne(`
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
                      OR (',' || replace(COALESCE(allowed_units, ''), ' ', '') || ',') LIKE ('%,' || ? || ',%')
                      OR (',' || replace(COALESCE(allowed_user_ids, ''), ' ', '') || ',') LIKE ('%,' || ? || ',%')
                  )
              )
          )
    `, [serverId, user.id, isSuperAdmin(user) ? 1 : 0, String(user?.unit || '').trim(), String(user?.id || '')]);
    if (row?.api_key) row.api_key = decryptSecret(row.api_key);
    return row || null;
}

async function listMcpServers(user) {
    const rows = await query(`
        SELECT s.*,
               COALESCE(NULLIF(u.deleted_username, ''), u.username) AS owner_username,
               u.nickname AS owner_nickname,
               u.unit AS owner_unit,
               u.role AS owner_role,
               bc.id AS builtin_id, bc.service_type AS builtin_service_type, bc.config AS builtin_config_json, bc.secret AS builtin_secret, bc.status AS builtin_status, bc.updated_at AS builtin_updated_at,
               dc.id AS db_conn_id, dc.database_type AS db_conn_type, dc.database_name AS db_conn_name, dc.host AS db_conn_host, dc.port AS db_conn_port, dc.username AS db_conn_username, dc.password AS db_conn_password, dc.options AS db_conn_options, dc.status AS db_conn_status, dc.updated_at AS db_conn_updated_at
        FROM mcp_servers s
        LEFT JOIN users u ON u.id = s.user_id
        LEFT JOIN mcp_builtin_configs bc ON bc.mcp_server_id = s.id AND bc.status != 'deleted'
        LEFT JOIN mcp_database_connections dc ON dc.mcp_server_id = s.id AND dc.status != 'deleted'
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
                      OR (',' || replace(COALESCE(s.allowed_units, ''), ' ', '') || ',') LIKE ('%,' || ? || ',%')
                      OR (',' || replace(COALESCE(s.allowed_user_ids, ''), ' ', '') || ',') LIKE ('%,' || ? || ',%')
                  )
              )
          )
        ORDER BY s.user_id IS NOT NULL, s.name ASC
    `, [user.id, isSuperAdmin(user) ? 1 : 0, String(user?.unit || '').trim(), String(user?.id || '')]);
    return rows.map(row => ({
        ...normalizeServerRow(row),
        can_edit: Number(row.user_id) === Number(user?.id) || (row.user_id === null && isSuperAdmin(user)),
        read_only: isUnitSharedMcpServer(row) && Number(row.user_id) !== Number(user?.id)
    }));
}

async function getMcpServerShareOptions(serverId, user) {
    const row = await queryOne(`
        SELECT s.*, u.unit AS owner_unit
        FROM mcp_servers s
        LEFT JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.status != 'deleted'
    `, [serverId]);
    if (!row || (Number(row.user_id) !== Number(user?.id) && !isSuperAdmin(user))) return null;
    return {
        server: normalizeServerRow(row),
        ...(await listShareTargets(user, { excludeUserId: row.user_id })),
        supportsSharing: String(row.base_url || '').startsWith('pivot-db://')
    };
}

async function updateMcpServerSharing(serverId, user, body = {}) {
    const row = await queryOne("SELECT * FROM mcp_servers WHERE id = ? AND status != 'deleted'", [serverId]);
    if (!row || (Number(row.user_id) !== Number(user?.id) && !isSuperAdmin(user))) return null;
    if (row.user_id === null) {
        const err = new Error('全局服务不需要单位共享设置。');
        err.status = 400;
        throw err;
    }
    const settings = normalizeShareSettings(body, user, row);
    settings.allowedUserIds = await filterExistingShareUserIds(settings.allowedUserIds, { excludeUserId: row.user_id });
    if (settings.scope === 'shared' && row.user_id !== null && !String(row.base_url || '').startsWith('pivot-db://')) {
        const err = new Error('当前阶段仅支持共享只读数据库能力，外部服务和通知服务不能共享。');
        err.status = 400;
        throw err;
    }
    await execute(`
        UPDATE mcp_servers
        SET scope = ?, allowed_units = ?, allowed_user_ids = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND status != 'deleted'
    `, [settings.scope, settings.allowedUnits, settings.allowedUserIds, getBeijingTimestamp(), serverId, row.user_id]);
    return await getAccessibleMcpServer(serverId, user);
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
        throw new Error(`不支持的数据库 MCP 方法: ${method}`);
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
        throw new Error(`不支持的内置 MCP 方法: ${method}`);
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

async function upsertToolCache(serverId, tools = []) {
    const now = getBeijingTimestamp();
    await transaction(async trx => {
        await trx.execute('DELETE FROM mcp_tool_cache WHERE server_id = ?', [serverId]);
        for (const tool of tools) {
            const name = String(tool.name || '').trim();
            if (!name) continue;
            await trx.execute(`
                INSERT INTO mcp_tool_cache (server_id, name, description, input_schema, cached_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(server_id, name) DO UPDATE SET
                    description = excluded.description,
                    input_schema = excluded.input_schema,
                    cached_at = excluded.cached_at
            `, [
                serverId,
                name,
                String(tool.description || ''),
                JSON.stringify(tool.inputSchema || tool.input_schema || { type: 'object' }),
                now
            ]);
        }
    });
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
        await upsertToolCache(server.id, normalizedTools);
        await execute('UPDATE mcp_servers SET last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?', [
            '', getBeijingTimestamp(), getBeijingTimestamp(), server.id
        ]);
        return await listCachedMcpTools(server.id, user);
    } catch (e) {
        await execute('UPDATE mcp_servers SET last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?', [
            e.message, getBeijingTimestamp(), getBeijingTimestamp(), server.id
        ]);
        throw e;
    }
}

async function listCachedMcpTools(serverId = null, user = null) {
    if (isLocalDeviceMcpServerId(serverId)) {
        const directLocalTools = listLocalDeviceMcpTools(user);
        return directLocalTools.length ? directLocalTools : listBridgeLocalDeviceMcpTools(user);
    }
    if (serverId) {
        const rows = await query(`
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
        `, [serverId]);
        return rows
            .filter(row => isSuperAdmin(user) || canAccessSharedResource(row, user))
            .filter(row => isSharedMcpToolAllowed(row, row.name))
            .map(formatMcpTool);
    }
    const rows = await query(`
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
    `);
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
    if (!match) throw new Error('MCP 工具名称非法。');
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
    const server = await getAccessibleMcpServer(Number(match[1]), user);
    if (!server || server.status !== 'active') throw new Error('MCP 服务当前不可用。');
    if (!isSharedMcpToolAllowed(server, match[2])) {
        const err = new Error('共享工具仅允许执行只读数据库能力。');
        err.status = 403;
        throw err;
    }
    const serverType = String(server.base_url || '').startsWith('pivot-db://')
        ? 'database_connection'
        : 'mcp_server';
    const { isToolCapabilityEnabled } = require('./capability-market');
    if (!(await isToolCapabilityEnabled(serverType, String(server.id), match[2], user))) {
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
