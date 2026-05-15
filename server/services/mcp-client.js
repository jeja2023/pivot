const axios = require('axios');
const { db } = require('../db');
const { getBeijingTimestamp } = require('../time');
const { decryptSecret, validateModelUrl } = require('../security');

const MCP_TIMEOUT_MS = 20000;
const isSuperAdmin = (user) => user?.username === 'admin';

function normalizeServerRow(row) {
    if (!row) return null;
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
        has_api_key: Boolean(row.api_key)
    };
}

function getAccessibleMcpServer(serverId, user) {
    const row = db.prepare(`
        SELECT * FROM mcp_servers
        WHERE id = ? AND status != 'deleted'
          AND (user_id IS NULL OR user_id = ? OR ? = 1)
    `).get(serverId, user.id, isSuperAdmin(user) ? 1 : 0);
    if (row?.api_key) row.api_key = decryptSecret(row.api_key);
    return row || null;
}

function listMcpServers(user) {
    const rows = db.prepare(`
        SELECT * FROM mcp_servers
        WHERE status != 'deleted'
          AND (user_id IS NULL OR user_id = ? OR ? = 1)
        ORDER BY user_id IS NOT NULL, name ASC
    `).all(user.id, isSuperAdmin(user) ? 1 : 0);
    return rows.map(normalizeServerRow);
}

async function callMcpJsonRpc(server, method, params = {}) {
    const url = String(server.base_url || '').trim().replace(/\/+$/, '');
    const response = await axios.post(url, {
        jsonrpc: '2.0',
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        method,
        params
    }, {
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': server.api_key ? `Bearer ${server.api_key}` : undefined,
            'x-api-key': server.api_key || undefined,
            'User-Agent': 'Pivot-MCP-Client/1.0'
        },
        timeout: MCP_TIMEOUT_MS,
        proxy: false
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

async function refreshMcpTools(server, user) {
    validateModelUrl(server.base_url, user);
    try {
        const result = await callMcpJsonRpc(server, 'tools/list', {});
        const tools = Array.isArray(result?.tools) ? result.tools : Array.isArray(result) ? result : [];
        upsertToolCache(server.id, tools.filter(tool => tool?.name));
        db.prepare('UPDATE mcp_servers SET last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?')
          .run('', getBeijingTimestamp(), getBeijingTimestamp(), server.id);
        return listCachedMcpTools(server.id);
    } catch (e) {
        db.prepare('UPDATE mcp_servers SET last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?')
          .run(e.message, getBeijingTimestamp(), getBeijingTimestamp(), server.id);
        throw e;
    }
}

function listCachedMcpTools(serverId = null, user = null) {
    if (serverId) {
        return db.prepare(`
            SELECT t.*, s.name AS server_name
            FROM mcp_tool_cache t
            JOIN mcp_servers s ON s.id = t.server_id
            WHERE t.server_id = ?
            ORDER BY t.name ASC
        `).all(serverId).map(formatMcpTool);
    }
    const rows = db.prepare(`
        SELECT t.*, s.name AS server_name
        FROM mcp_tool_cache t
        JOIN mcp_servers s ON s.id = t.server_id
        WHERE s.status = 'active'
          AND (? IS NULL OR s.user_id IS NULL OR s.user_id = ? OR ? = 1)
        ORDER BY s.name ASC, t.name ASC
    `).all(user?.id || null, user?.id || null, isSuperAdmin(user) ? 1 : 0);
    return rows.map(formatMcpTool);
}

function formatMcpTool(row) {
    let schema = { type: 'object' };
    try {
        schema = JSON.parse(row.input_schema || '{}') || schema;
    } catch (e) {}
    return {
        serverId: row.server_id,
        serverName: row.server_name,
        name: row.name,
        fullName: `mcp.${row.server_id}.${row.name}`,
        description: row.description || '',
        input_schema: schema,
        cached_at: row.cached_at
    };
}

async function executeMcpTool(fullName, input, user) {
    const match = String(fullName || '').match(/^mcp\.(\d+)\.(.+)$/);
    if (!match) throw new Error('Invalid MCP tool name.');
    const server = getAccessibleMcpServer(Number(match[1]), user);
    if (!server || server.status !== 'active') throw new Error('MCP server is not available.');
    validateModelUrl(server.base_url, user);
    return callMcpJsonRpc(server, 'tools/call', {
        name: match[2],
        arguments: input || {}
    });
}

module.exports = {
    executeMcpTool,
    getAccessibleMcpServer,
    listCachedMcpTools,
    listMcpServers,
    normalizeServerRow,
    refreshMcpTools
};
