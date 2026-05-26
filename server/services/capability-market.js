const { db } = require('../db');
const { getBeijingTimestamp } = require('../time');
const { getBuiltInToolDefinitions } = require('./agent-tools');
const { listMcpServers } = require('./mcp-client');

const PACKAGE_TYPES = new Set(['builtin_tool', 'mcp_server', 'database_connection']);
const PACKAGE_STATUSES = new Set(['enabled', 'disabled']);
const isSuperAdmin = (user) => user?.username === 'admin';

function sourceKey(type, ref) {
    return `${type}:${String(ref || '').trim()}`;
}

function normalizeStatus(value) {
    return PACKAGE_STATUSES.has(value) ? value : 'enabled';
}

function cleanCapabilityName(name) {
    return String(name || '')
        .replace(/^内置\s*/u, '')
        .replace(/^系统内置\s*/u, '')
        .replace(/\s*MCP$/iu, '')
        .trim();
}

function upsertCapabilityPackage({ type, sourceRef, name, description = '', scope = 'user', userId = null, status = 'enabled', config = {} }) {
    if (!PACKAGE_TYPES.has(type) || !sourceRef || !name) return null;
    const key = sourceKey(type, sourceRef);
    const now = getBeijingTimestamp();
    db.prepare(`
        INSERT INTO capability_packages (
            package_key, type, source_ref, user_id, scope, name, description, status, config, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(package_key) DO UPDATE SET
            type = excluded.type,
            source_ref = excluded.source_ref,
            user_id = excluded.user_id,
            scope = excluded.scope,
            name = excluded.name,
            description = excluded.description,
            status = CASE WHEN excluded.type IN ('mcp_server', 'database_connection') THEN excluded.status ELSE capability_packages.status END,
            config = CASE WHEN excluded.type IN ('mcp_server', 'database_connection') THEN excluded.config ELSE capability_packages.config END,
            updated_at = excluded.updated_at
    `).run(
        key,
        type,
        String(sourceRef),
        userId,
        scope,
        cleanCapabilityName(name).slice(0, 120),
        String(description || '').slice(0, 1000),
        normalizeStatus(status),
        JSON.stringify(config || {}),
        now,
        now
    );
    return db.prepare('SELECT * FROM capability_packages WHERE package_key = ?').get(key);
}

function syncCapabilityPackages(user) {
    getBuiltInToolDefinitions(user).forEach(tool => {
        upsertCapabilityPackage({
            type: 'builtin_tool',
            sourceRef: tool.name,
            name: tool.title || tool.name,
            description: tool.description || '',
            scope: tool.admin ? 'admin' : 'global',
            userId: null,
            config: { toolName: tool.name, admin: Boolean(tool.admin) }
        });
    });

    listMcpServers(user).forEach(server => {
        const isDatabase = server.server_type === 'database';
        upsertCapabilityPackage({
            type: isDatabase ? 'database_connection' : 'mcp_server',
            sourceRef: String(server.id),
            name: server.name,
            description: server.description || server.base_url || '',
            scope: server.user_id ? 'user' : 'global',
            userId: server.user_id || null,
            status: server.status === 'active' ? 'enabled' : 'disabled',
            config: {
                serverId: server.id,
                serverType: server.server_type,
                databaseType: server.database_connection?.database_type || ''
            }
        });
    });
}

function canAccessPackage(row, user) {
    if (!row) return false;
    if (isSuperAdmin(user)) return true;
    if (row.scope === 'admin') return false;
    return !row.user_id || row.user_id === user.id;
}

function listCapabilityPackages(user) {
    syncCapabilityPackages(user);
    const rows = db.prepare(`
        SELECT *
        FROM capability_packages
        WHERE (? = 1 OR scope != 'admin')
          AND (? = 1 OR user_id IS NULL OR user_id = ?)
        ORDER BY
            CASE type WHEN 'builtin_tool' THEN 1 WHEN 'database_connection' THEN 2 ELSE 3 END,
            name ASC
    `).all(isSuperAdmin(user) ? 1 : 0, isSuperAdmin(user) ? 1 : 0, user.id);
    return rows.map(row => ({
        ...row,
        enabled: row.status !== 'disabled',
        config: (() => {
            try { return JSON.parse(row.config || '{}'); } catch (e) { return {}; }
        })()
    }));
}

function setCapabilityPackageStatus(packageKey, user, status = 'enabled') {
    const row = db.prepare('SELECT * FROM capability_packages WHERE package_key = ?').get(packageKey);
    if (!canAccessPackage(row, user)) return null;
    if (row.scope === 'global' && !isSuperAdmin(user)) {
        const err = new Error('只有 admin 超级管理员可以启停全局能力包。');
        err.status = 403;
        throw err;
    }
    const nextStatus = normalizeStatus(status);
    db.prepare('UPDATE capability_packages SET status = ?, updated_at = ? WHERE package_key = ?')
        .run(nextStatus, getBeijingTimestamp(), packageKey);
    return db.prepare('SELECT * FROM capability_packages WHERE package_key = ?').get(packageKey);
}

function isCapabilityEnabled(type, sourceRef, user = null) {
    const key = sourceKey(type, sourceRef);
    const row = db.prepare('SELECT status, scope, user_id FROM capability_packages WHERE package_key = ?').get(key);
    if (!row) return true;
    if (user && !canAccessPackage(row, user)) return false;
    return row.status !== 'disabled';
}

function filterBuiltInToolsByCapability(tools, user) {
    return tools.filter(tool => isCapabilityEnabled('builtin_tool', tool.name, user));
}

function filterMcpToolsByCapability(tools, user) {
    return tools.filter(tool => {
        const type = String(tool.name || '').startsWith('db.') || String(tool.fullName || '').includes('.db.')
            ? 'database_connection'
            : 'mcp_server';
        return isCapabilityEnabled(type, String(tool.serverId || ''), user);
    });
}

module.exports = {
    filterBuiltInToolsByCapability,
    filterMcpToolsByCapability,
    isCapabilityEnabled,
    listCapabilityPackages,
    setCapabilityPackageStatus,
    syncCapabilityPackages,
    upsertCapabilityPackage
};
