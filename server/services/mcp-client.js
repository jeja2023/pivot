const { query, queryOne, execute, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const {
    decryptSecret,
    validateMcpEndpointUrl,
    assertSafeMcpOutboundUrl,
    createSafeHttpAgentsForUser,
    redactSecrets
} = require('../security');
const { safeJsonGet, safeJsonPost } = require('./safe-http-client');
const {
    executeDatabaseMcpTool,
    getDatabaseConnectionForServerAsync,
    listDatabaseMcpTools,
    normalizeDatabaseConnection
} = require('./database-mcp');
const {
    executeBuiltinMcpTool,
    getBuiltinConfigForServerAsync,
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
const externalMcpSessions = new Map();
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

function headerValue(headers = {}, name) {
    const target = String(name || '').toLowerCase();
    const key = Object.keys(headers || {}).find(item => String(item).toLowerCase() === target);
    return key ? headers[key] : undefined;
}

function parseMcpJsonRpcPayload(payload) {
    if (payload && typeof payload === 'object') return payload;
    const text = String(payload || '').trim();
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) {
        const dataLines = text.split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim())
            .filter(Boolean);
        const candidate = dataLines.at(-1) || text;
        try { return JSON.parse(candidate); } catch (error) {
            error.message = 'MCP 服务返回了无法解析的 JSON-RPC 响应。';
            throw error;
        }
    }
}

function readMcpStreamResponse(response, requestId, {
    onNotification,
    signal,
    maxBytes = 4 * 1024 * 1024,
    onReconnect = null,
    keepAlive = false
} = {}) {
    const stream = response?.data;
    if (!stream || typeof stream.on !== 'function') return Promise.resolve(parseMcpJsonRpcPayload(stream));
    return new Promise((resolve, reject) => {
        let buffer = '';
        let dataLines = [];
        let bytes = 0;
        let settled = false;
        let ended = false;
        let reconnecting = false;
        let currentEventId = '';
        let lastEventId = '';
        let retryMs = null;
        const handleMessage = message => {
            if (!message || typeof message !== 'object') return;
            if (requestId && String(message.id ?? '') === String(requestId)) {
                if (!settled) {
                    settled = true;
                    resolve(message);
                }
                if (!keepAlive) stream.destroy?.();
                return;
            }
            try { onNotification?.(message); } catch (_) {}
        };
        const flush = () => {
            if (!dataLines.length) {
                if (currentEventId) lastEventId = currentEventId;
                currentEventId = '';
                return;
            }
            const payload = dataLines.join('\n');
            dataLines = [];
            if (currentEventId) lastEventId = currentEventId;
            currentEventId = '';
            if (payload === '[DONE]') return;
            try { handleMessage(parseMcpJsonRpcPayload(payload)); } catch (error) {
                if (!settled) {
                    settled = true;
                    reject(error);
                }
            }
        };
        const consume = text => {
            buffer += text;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) flush();
                else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
                else if (line.startsWith('id:')) currentEventId = line.slice(3).trim();
                else if (line.startsWith('retry:')) {
                    const value = Number.parseInt(line.slice(6).trim(), 10);
                    if (Number.isFinite(value) && value >= 0) retryMs = value;
                }
                else if (!dataLines.length && line.trim().startsWith('{')) dataLines.push(line.trim());
            }
        };
        const onData = chunk => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > maxBytes) {
                const error = new Error('MCP SSE 响应超过大小限制。');
                error.code = 'MCP_RESPONSE_TOO_LARGE';
                if (!settled) {
                    settled = true;
                    reject(error);
                }
                stream.destroy?.(error);
                return;
            }
            consume(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        };
        const onEnd = async () => {
            ended = true;
            if (buffer) consume('\n');
            flush();
            if (!settled) {
                if (typeof onReconnect === 'function' && !reconnecting) {
                    reconnecting = true;
                    try {
                        const message = await onReconnect({ lastEventId, retryMs });
                        if (!settled) {
                            settled = true;
                            resolve(message);
                        }
                    } catch (error) {
                        if (!settled) {
                            settled = true;
                            reject(error);
                        }
                    }
                    return;
                }
                settled = true;
                reject(new Error('MCP SSE 响应在返回 JSON-RPC 结果前结束。'));
            }
        };
        const onError = error => {
            if (!settled) {
                settled = true;
                reject(error);
            } else {
                try { onNotification?.({ type: 'stream.error', error: { message: String(error?.message || error) } }); } catch (_) {}
            }
        };
        stream.on('data', onData);
        stream.once('end', () => { void onEnd(); });
        stream.once('error', onError);
        if (signal) {
            const abort = () => stream.destroy?.(signal.reason || new Error('MCP 请求已取消。'));
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
            stream.once('close', () => signal.removeEventListener?.('abort', abort));
        }
        if (ended) onEnd();
    });
}

function drainMcpResponse(response) {
    const stream = response?.data;
    if (!stream || typeof stream.on !== 'function') return Promise.resolve();
    return new Promise(resolve => {
        stream.once('end', resolve);
        stream.once('error', resolve);
        stream.once('close', resolve);
        stream.resume?.();
    });
}

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

async function normalizeServerRowAsync(row) {
    const normalized = normalizeServerRow(row);
    if (!normalized) return null;

    if (!normalized.database_connection && String(row.base_url || '').startsWith('pivot-db://')) {
        normalized.database_connection = await getDatabaseConnectionForServerAsync(row.id);
        normalized.server_type = 'database';
    }

    const builtinType = getBuiltinServiceTypeFromUrl(row.base_url);
    if (!normalized.builtin_config && builtinType) {
        normalized.builtin_config = await getBuiltinConfigForServerAsync(row.id);
        normalized.server_type = builtinType;
    }

    return normalized;
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
        server: await normalizeServerRowAsync(row),
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
        if (method === 'tools/list') return { tools: await listDatabaseMcpTools(server) };
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
    const protocolMode = String(config.protocolMode || config.protocol_mode || 'legacy').toLowerCase() === 'standard' ? 'standard' : 'legacy';
    const authMode = String(config.authMode || config.auth_mode || 'auto').toLowerCase();
    const headers = {
        'Content-Type': 'application/json',
        'Accept': protocolMode === 'standard' ? 'application/json, text/event-stream' : 'application/json',
        'User-Agent': 'Pivot-MCP-Client/1.0'
    };
    const protocolVersion = String(config.protocolVersion || config.protocol_version || options.protocolVersion || '2024-11-05');
    if (protocolMode === 'standard') headers['MCP-Protocol-Version'] = protocolVersion;
    if (server.api_key && authMode !== 'none') {
        if (authMode === 'bearer') headers.Authorization = `Bearer ${server.api_key}`;
        else if (authMode === 'x-api-key') headers['x-api-key'] = server.api_key;
        else {
            headers.Authorization = `Bearer ${server.api_key}`;
            headers['x-api-key'] = server.api_key;
        }
    }
    const sessionKey = String(server.id || url);
    const send = async (requestMethod, requestParams, requestHeaders, notification = false) => {
        const requestId = notification ? '' : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const maxReconnects = Math.max(0, Math.min(Number(options.maxReconnects ?? config.maxReconnects ?? 3) || 0, 8));
        const requestOptions = {
            user,
            assertUrl: (targetUrl, targetUser) => assertSafeMcpOutboundUrl(targetUrl, targetUser),
            createAgents: (targetUser) => createSafeHttpAgentsForUser(targetUser, {
                allowPrivateEnv: 'ALLOW_PRIVATE_MCP_URLS',
                allowExplicitLoopbackForAdmin: true
            }),
            headers: requestHeaders,
            timeout: timeoutMs,
            signal: options.signal || null,
            responseType: protocolMode === 'standard' ? 'stream' : 'json',
            maxContentLength: 4 * 1024 * 1024
        };
        const response = await safeJsonPost(url, {
            jsonrpc: '2.0',
            ...(notification ? {} : { id: requestId }),
            method: requestMethod,
            params: requestParams
        }, requestOptions);
        if (notification) {
            if (protocolMode === 'standard') await drainMcpResponse(response);
            return response;
        }
        if (protocolMode !== 'standard') return response;
        const readStream = async (streamResponse, attempt, streamHeaders) => readMcpStreamResponse(streamResponse, requestId, {
            signal: options.signal || null,
            onNotification: options.onNotification,
            maxBytes: 4 * 1024 * 1024,
            keepAlive: options.keepAlive === true,
            onReconnect: attempt < maxReconnects
                ? async ({ lastEventId, retryMs }) => {
                    const waitMs = Math.max(0, Math.min(Number(retryMs) || 0, timeoutMs));
                    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
                    options.signal?.throwIfAborted?.();
                    const reconnectHeaders = { ...streamHeaders };
                    if (lastEventId) reconnectHeaders['Last-Event-ID'] = lastEventId;
                    const reconnectResponse = await safeJsonGet(url, {
                        ...requestOptions,
                        headers: reconnectHeaders,
                        responseType: 'stream'
                    });
                    const reconnectSessionId = headerValue(reconnectResponse.headers, 'mcp-session-id');
                    if (reconnectSessionId) externalMcpSessions.set(sessionKey, String(reconnectSessionId));
                    return readStream(reconnectResponse, attempt + 1, reconnectHeaders);
                }
                : null
        });
        const message = await readStream(response, 0, requestHeaders);
        return { ...response, data: message };
    };
    const parseResponse = (response, strict = protocolMode === 'standard') => {
        let data = response.data;
        if (typeof data === 'string') {
            const events = data.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean);
            const candidate = events.at(-1) || data.trim();
            try { data = JSON.parse(candidate); } catch (e) { throw new Error('MCP 服务返回了无法解析的 JSON-RPC 响应。'); }
        }
        if (!data || (strict && data.jsonrpc !== '2.0')) throw new Error('MCP 服务返回了无效的 JSON-RPC 响应。');
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        return data.result;
    };
    if (protocolMode === 'standard' && method !== 'initialize' && !externalMcpSessions.has(sessionKey)) {
        const initResponse = await send('initialize', {
            protocolVersion,
            capabilities: { tools: {} },
            clientInfo: { name: 'Pivot-MCP-Client', version: '0.1.13' }
        }, headers);
        parseResponse(initResponse, true);
        const initHeaders = initResponse.headers || {};
        const sessionId = headerValue(initHeaders, 'mcp-session-id');
        if (sessionId) externalMcpSessions.set(sessionKey, String(sessionId));
        const sessionHeaders = { ...headers };
        if (sessionId) sessionHeaders['Mcp-Session-Id'] = String(sessionId);
        await send('notifications/initialized', {}, sessionHeaders, true);
    }
    if (protocolMode === 'standard') {
        const sessionId = externalMcpSessions.get(sessionKey);
        if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    }
    const response = await send(method, params, headers);
    const result = parseResponse(response);
    if (protocolMode === 'standard' && method === 'initialize') {
        const sessionId = response.headers?.['mcp-session-id'] || response.headers?.['Mcp-Session-Id'];
        const initializedHeaders = { ...headers };
        if (sessionId) {
            externalMcpSessions.set(sessionKey, String(sessionId));
            initializedHeaders['Mcp-Session-Id'] = String(sessionId);
        }
        await send('notifications/initialized', {}, initializedHeaders, true);
    }
    return result;
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
        const visibleRows = rows
            .filter(row => isSuperAdmin(user) || canAccessSharedResource(row, user))
            .filter(row => isSharedMcpToolAllowed(row, row.name));
        return await Promise.all(visibleRows.map(row => formatMcpTool(row, user)));
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
    const visibleRows = rows
        .filter(row => isSuperAdmin(user) || canAccessSharedResource(row, user))
        .filter(row => isSharedMcpToolAllowed(row, row.name));
    const formattedRows = await Promise.all(visibleRows.map(row => formatMcpTool(row, user)));
    return [
        ...directLocalTools,
        ...bridgeLocalTools,
        ...formattedRows
    ];
}

async function formatMcpTool(row, user = null) {
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
    const governance = await getCapabilityToolGovernance(packageType, String(row.server_id ?? ''), row.name, user);
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
        if (!(await isToolCapabilityEnabled(packageType, match[1], toolName, user))) {
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
    // 工具缓存是服务当前实际暴露能力的唯一目录。执行前重新校验，避免
    // 通过猜测工具名调用远程服务未声明、已删除或尚未刷新进缓存的工具。
    const cachedTools = await listCachedMcpTools(Number(server.id), user);
    const cachedTool = cachedTools.find(tool => String(tool.name || '') === String(match[2] || ''));
    if (!cachedTool) {
        const err = new Error('工具不在当前 MCP 服务缓存中，请先刷新工具列表。');
        err.status = 404;
        err.code = 'MCP_TOOL_NOT_CACHED';
        throw err;
    }
    const { isToolCapabilityEnabled } = require('./capability-market');
    if (!(await isToolCapabilityEnabled(serverType, String(server.id), cachedTool.name, user))) {
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
    callMcpJsonRpc,
    clearMcpSessions() { externalMcpSessions.clear(); },
    executeMcpTool,
    getAccessibleMcpServer,
    listCachedMcpTools,
    listMcpServers,
    getMcpServerShareOptions,
    updateMcpServerSharing,
    normalizeServerRow,
    normalizeServerRowAsync,
    recordMcpCallLog,
    refreshMcpTools
};
