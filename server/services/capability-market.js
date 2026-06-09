const { db } = require('../db');
const { getBeijingTimestamp } = require('../time');
const { getBuiltInToolDefinitions } = require('./agent-tools');
const { listMcpServers } = require('./mcp-client');
const { isSuperAdmin } = require('../permissions');

const PACKAGE_TYPES = new Set(['builtin_tool', 'mcp_server', 'database_connection']);
const PACKAGE_STATUSES = new Set(['enabled', 'disabled']);
const TOOL_RISK_LEVELS = new Set(['low', 'medium', 'high']);

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

function parsePackageConfig(value) {
    if (!value) return {};
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
        return {};
    }
}

function parseBoolean(value, fallback = false) {
    if (value === true || value === 'true' || value === 1 || value === '1') return true;
    if (value === false || value === 'false' || value === 0 || value === '0') return false;
    return fallback;
}

function normalizeToolGovernance(value = {}) {
    const enabled = parseBoolean(value.enabled, value.status !== 'disabled');
    const riskLevel = TOOL_RISK_LEVELS.has(value.riskLevel || value.risk_level)
        ? (value.riskLevel || value.risk_level)
        : 'medium';
    return {
        enabled,
        riskLevel,
        approvalRequired: parseBoolean(value.approvalRequired ?? value.approval_required, false),
        usage: String(value.usage || value.applicability || '').slice(0, 500)
    };
}

function normalizePackageConfig(config = {}, existing = {}) {
    const base = parsePackageConfig(config);
    const previous = parsePackageConfig(existing);
    return {
        ...previous,
        ...base,
        tools: {
            ...(previous.tools && typeof previous.tools === 'object' ? previous.tools : {}),
            ...(base.tools && typeof base.tools === 'object' ? base.tools : {})
        }
    };
}

function upsertCapabilityPackage({ type, sourceRef, name, description = '', scope = 'user', userId = null, status = 'enabled', config = {} }) {
    if (!PACKAGE_TYPES.has(type) || !sourceRef || !name) return null;
    const key = sourceKey(type, sourceRef);
    const now = getBeijingTimestamp();
    const existing = db.prepare('SELECT config FROM capability_packages WHERE package_key = ?').get(key);
    const nextConfig = normalizePackageConfig(config, existing?.config);
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
        JSON.stringify(nextConfig),
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
        config: parsePackageConfig(row.config)
    }));
}

function setCapabilityPackageStatus(packageKey, user, status = 'enabled') {
    const row = db.prepare('SELECT * FROM capability_packages WHERE package_key = ?').get(packageKey);
    if (!canAccessPackage(row, user)) return null;
    if (row.scope === 'global' && !isSuperAdmin(user)) {
        const err = new Error('只有 admin 权限层级可以启停全局能力包。');
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

function getCapabilityToolGovernance(type, sourceRef, toolName, user = null) {
    const key = sourceKey(type, sourceRef);
    const row = db.prepare('SELECT status, scope, user_id, config FROM capability_packages WHERE package_key = ?').get(key);
    if (!row) return normalizeToolGovernance();
    if (user && !canAccessPackage(row, user)) return { ...normalizeToolGovernance(), enabled: false };
    if (row.status === 'disabled') return { ...normalizeToolGovernance(), enabled: false };
    const config = parsePackageConfig(row.config);
    return normalizeToolGovernance(config.tools?.[toolName] || {});
}

function isToolCapabilityEnabled(type, sourceRef, toolName, user = null) {
    return getCapabilityToolGovernance(type, sourceRef, toolName, user).enabled;
}

function setCapabilityToolGovernance(packageKey, user, toolName, patch = {}) {
    const row = db.prepare('SELECT * FROM capability_packages WHERE package_key = ?').get(packageKey);
    if (!canAccessPackage(row, user)) return null;
    if (row.scope === 'global' && !isSuperAdmin(user)) {
        const err = new Error('只有 admin 权限层级可以调整全局能力工具。');
        err.status = 403;
        throw err;
    }
    const name = String(toolName || '').trim();
    if (!name) {
        const err = new Error('请指定工具名称。');
        err.status = 400;
        throw err;
    }
    const config = parsePackageConfig(row.config);
    const tools = config.tools && typeof config.tools === 'object' ? config.tools : {};
    const next = normalizeToolGovernance({
        ...(tools[name] || {}),
        ...patch
    });
    const nextConfig = {
        ...config,
        tools: {
            ...tools,
            [name]: next
        }
    };
    db.prepare('UPDATE capability_packages SET config = ?, updated_at = ? WHERE package_key = ?')
        .run(JSON.stringify(nextConfig), getBeijingTimestamp(), packageKey);
    return {
        packageKey,
        toolName: name,
        governance: next
    };
}

function filterBuiltInToolsByCapability(tools, user) {
    return tools
        .filter(tool => isCapabilityEnabled('builtin_tool', tool.name, user))
        .map(tool => ({
            ...tool,
            governance: getCapabilityToolGovernance('builtin_tool', tool.name, tool.name, user)
        }))
        .filter(tool => tool.governance.enabled);
}

function filterMcpToolsByCapability(tools, user) {
    return tools.map(tool => {
        const type = tool.serverType === 'database'
            ? 'database_connection'
            : 'mcp_server';
        const sourceRef = String(tool.serverId || '');
        const governance = getCapabilityToolGovernance(type, sourceRef, tool.name, user);
        return { ...tool, governance };
    }).filter(tool => tool.governance.enabled);
}

module.exports = {
    filterBuiltInToolsByCapability,
    filterMcpToolsByCapability,
    getCapabilityToolGovernance,
    isCapabilityEnabled,
    isToolCapabilityEnabled,
    listCapabilityPackages,
    setCapabilityPackageStatus,
    setCapabilityToolGovernance,
    syncCapabilityPackages,
    upsertCapabilityPackage
};
