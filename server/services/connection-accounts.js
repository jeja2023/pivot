'use strict';

const { query, queryOne, execute, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { isSuperAdmin } = require('../permissions');
const { decryptSecret } = require('../security');

const AUTH_STATES = new Set(['unconnected', 'authorizing', 'active', 'expiring', 'refresh_failed', 'disabled', 'revoked']);
const OWNERSHIP_SCOPES = new Set(['personal', 'unit', 'service']);

function parseJson(value, fallback) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value || '') || fallback; } catch (_) { return fallback; }
}

function databaseApi(executor) {
    return {
        one: (...args) => executor.queryOne(...args),
        many: (...args) => executor.query(...args),
        mutate: (...args) => executor.execute(...args)
    };
}

function publicConnectionAccount(row = {}) {
    return {
        ...row,
        scopes: Array.isArray(row.scopes) ? row.scopes : parseJson(row.scopes, []),
        metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : parseJson(row.metadata, {}),
        encrypted_secret_ref: row.encrypted_secret_ref ? 'configured' : '',
        isExpired: Boolean(row.expires_at && Date.parse(row.expires_at) <= Date.now())
    };
}

function assertState(value) {
    const state = String(value || '').trim();
    if (!AUTH_STATES.has(state)) {
        const error = new Error('连接账户状态无效。');
        error.status = 400;
        throw error;
    }
    return state;
}

function assertOwnershipScope(value) {
    const scope = String(value || 'personal').trim();
    if (!OWNERSHIP_SCOPES.has(scope)) {
        const error = new Error('连接账户归属范围无效。');
        error.status = 400;
        throw error;
    }
    return scope;
}

function canAccessConnectionAccount(row, user) {
    if (!row || !user) return false;
    if (isSuperAdmin(user)) return true;
    if (row.ownership_scope === 'service') return row.owner_user_id === null || Number(row.owner_user_id) === Number(user.id);
    return Number(row.owner_user_id) === Number(user.id);
}

function createConnectionAccountStore(deps = {}) {
    const read = deps.query || query;
    const readOne = deps.queryOne || queryOne;
    const write = deps.execute || execute;
    const transact = deps.transaction || transaction;
    const now = deps.getBeijingTimestamp || getBeijingTimestamp;

    async function ensureMcpConnectorDefinition(server, executor = { queryOne: readOne, execute: write }) {
        const db = databaseApi(executor);
        const slug = 'pivot.mcp-server';
        let definition = await db.one('SELECT * FROM connector_definitions WHERE slug = ?', [slug]);
        if (!definition) {
            definition = await db.one(`
                INSERT INTO connector_definitions (
                    slug, display_name, category, auth_type, supported_protocols, owner, version, status, created_at, updated_at
                ) VALUES (?, ?, 'mcp', 'api_key', ?::jsonb, 'Pivot', '1.0.0', 'active', ?, ?)
                RETURNING *
            `, [slug, 'MCP 工具服务', JSON.stringify(['mcp']), now(), now()]);
        }
        return definition;
    }

    async function createAccount(user, input = {}) {
        const connectorId = Number(input.connectorId ?? input.connector_id);
        if (!Number.isSafeInteger(connectorId) || connectorId <= 0) {
            const error = new Error('请选择有效的连接器。'); error.status = 400; throw error;
        }
        const definition = await readOne("SELECT * FROM connector_definitions WHERE id = ? AND status = 'active'", [connectorId]);
        if (!definition) {
            const error = new Error('连接器不存在或已停用。'); error.status = 404; throw error;
        }
        const scope = assertOwnershipScope(input.ownershipScope ?? input.ownership_scope ?? 'personal');
        if (scope !== 'personal' && !isSuperAdmin(user)) {
            const error = new Error('只有管理员可以创建单位或服务账号连接。'); error.status = 403; throw error;
        }
        const requestedDisplayName = input.displayName ?? input.display_name ?? definition.display_name ?? '';
        const displayName = String(requestedDisplayName).trim().slice(0, 255);
        if (!displayName) {
            const error = new Error('请填写连接账户名称。'); error.status = 400; throw error;
        }
        const nowValue = now();
        const row = await readOne(`
            INSERT INTO connection_accounts (
                connector_id, server_id, tenant_id, owner_user_id, ownership_scope, display_name, auth_state,
                scopes, metadata, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'unconnected', ?::jsonb, ?::jsonb, ?, ?) RETURNING *
        `, [
            definition.id, Number(input.serverId ?? input.server_id) || null, input.tenantId ?? input.tenant_id ?? null,
            scope === 'service' ? null : user.id, scope, displayName,
            JSON.stringify(Array.isArray(input.scopes) ? input.scopes.slice(0, 100) : []), JSON.stringify(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}), nowValue, nowValue
        ]);
        return publicConnectionAccount(row);
    }

    async function ensureLegacyMcpAccount(server, user = null) {
        if (!server?.id) return null;
        return transact(async trx => {
            const db = databaseApi(trx);
            const definition = await ensureMcpConnectorDefinition(server, trx);
            const ownerUserId = server.user_id ?? user?.id ?? null;
            const existing = await db.one(`
                SELECT * FROM connection_accounts
                WHERE server_id = ? AND owner_user_id IS NOT DISTINCT FROM ?
                ORDER BY id ASC LIMIT 1
            `, [server.id, ownerUserId]);
            if (existing) return publicConnectionAccount(existing);
            const databaseBacked = String(server.base_url || '').startsWith('pivot-db://');
            const state = server.api_key || databaseBacked ? 'active' : 'unconnected';
            const row = await db.one(`
                INSERT INTO connection_accounts (
                    connector_id, server_id, owner_user_id, ownership_scope, display_name, auth_state,
                    encrypted_secret_ref, metadata, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
                RETURNING *
            `, [
                definition.id, server.id, ownerUserId, ownerUserId ? 'personal' : 'service',
                `${server.name || 'MCP 服务'} 连接`, state,
                server.api_key ? `mcp_servers:${server.id}:api_key` : (databaseBacked ? `mcp_database_connections:${server.id}` : ''), JSON.stringify({ legacyServerId: server.id, migration: 'compatibility' }), now(), now()
            ]);
            return publicConnectionAccount(row);
        });
    }

    async function listForUser(user, options = {}) {
        const includeInactive = options.includeInactive === true;
        const rows = await read(`
            SELECT a.*, d.slug AS connector_slug, d.display_name AS connector_name, d.auth_type, d.category
            FROM connection_accounts a
            JOIN connector_definitions d ON d.id = a.connector_id
            WHERE (? = 1 OR a.owner_user_id = ? OR (a.ownership_scope = 'service' AND a.owner_user_id IS NULL))
              AND (? = 1 OR a.auth_state NOT IN ('revoked', 'disabled'))
            ORDER BY a.updated_at DESC, a.id DESC
        `, [isSuperAdmin(user) ? 1 : 0, user?.id || 0, includeInactive ? 1 : 0]);
        return rows.map(publicConnectionAccount);
    }

    async function getForUser(id, user) {
        const row = await readOne(`
            SELECT a.*, d.slug AS connector_slug, d.display_name AS connector_name, d.auth_type, d.category
            FROM connection_accounts a JOIN connector_definitions d ON d.id = a.connector_id
            WHERE a.id = ?
        `, [id]);
        return canAccessConnectionAccount(row, user) ? publicConnectionAccount(row) : null;
    }

    async function transition(id, user, patch = {}) {
        const current = await readOne('SELECT * FROM connection_accounts WHERE id = ?', [id]);
        if (!canAccessConnectionAccount(current, user)) {
            const error = new Error('连接账户不存在或无权访问。');
            error.status = 404;
            throw error;
        }
        const state = patch.authState === undefined && patch.auth_state === undefined ? current.auth_state : assertState(patch.authState ?? patch.auth_state);
        const requestedDisplayName = patch.displayName ?? patch.display_name ?? current.display_name ?? '';
        const displayName = String(requestedDisplayName).trim().slice(0, 255) || current.display_name;
        const scopes = Array.isArray(patch.scopes) ? patch.scopes.map(item => String(item || '').trim()).filter(Boolean).slice(0, 100) : parseJson(current.scopes, []);
        const expiresAt = patch.expiresAt ?? patch.expires_at ?? current.expires_at ?? null;
        const lastError = String(patch.lastError ?? patch.last_error ?? (state === 'active' ? '' : current.last_error || '')).slice(0, 2000);
        const revokedAt = state === 'revoked' ? now() : (current.revoked_at || null);
        await write(`
            UPDATE connection_accounts
            SET display_name = ?, auth_state = ?, scopes = ?::jsonb, expires_at = ?,
                last_refresh_at = CASE WHEN ? = 'active' THEN ? ELSE last_refresh_at END,
                last_error = ?, revoked_at = ?, updated_at = ?
            WHERE id = ?
        `, [displayName, state, JSON.stringify(scopes), expiresAt, state, now(), lastError, revokedAt, now(), id]);
        return await getForUser(id, user);
    }

    async function assertUsable(id, user, requiredScopes = []) {
        const account = await getForUser(id, user);
        if (!account) {
            const error = new Error('未找到可用的连接账户。');
            error.code = 'CONNECTION_ACCOUNT_UNAVAILABLE';
            error.status = 403;
            throw error;
        }
        if (account.auth_state !== 'active') {
            const error = new Error(account.auth_state === 'revoked' ? '连接授权已撤销，请重新授权。' : '连接账户当前不可用，请完成授权或修复连接。');
            error.code = account.auth_state === 'revoked' ? 'CONNECTION_ACCOUNT_REVOKED' : 'CONNECTION_ACCOUNT_REAUTH_REQUIRED';
            error.status = 403;
            throw error;
        }
        if (account.isExpired) {
            const error = new Error('连接授权已过期，请重新授权。');
            error.code = 'CONNECTION_ACCOUNT_EXPIRED';
            error.status = 403;
            throw error;
        }
        const scopes = new Set(account.scopes || []);
        const missing = (requiredScopes || []).filter(scope => !scopes.has(scope));
        if (missing.length) {
            const error = new Error('连接账户缺少调用该工具所需的授权范围。');
            error.code = 'CONNECTION_ACCOUNT_SCOPE_MISSING';
            error.status = 403;
            error.missingScopes = missing;
            throw error;
        }
        return account;
    }

    async function bindToolConnection(user, input = {}) {
        const toolItemId = Number(input.toolItemId ?? input.tool_item_id);
        const connectionAccountId = Number(input.connectionAccountId ?? input.connection_account_id);
        if (!Number.isSafeInteger(toolItemId) || toolItemId <= 0 || !Number.isSafeInteger(connectionAccountId) || connectionAccountId <= 0) {
            const error = new Error('请指定有效的工具目录项和连接账户。'); error.status = 400; throw error;
        }
        const account = await getForUser(connectionAccountId, user);
        if (!account) {
            const error = new Error('连接账户不存在或无权访问。'); error.status = 404; throw error;
        }
        const tool = await readOne('SELECT id, server_id FROM tool_catalog_items WHERE id = ?', [toolItemId]);
        if (!tool) {
            const error = new Error('工具目录项不存在。'); error.status = 404; throw error;
        }
        if (account.server_id && Number(account.server_id) !== Number(tool.server_id)) {
            const error = new Error('连接账户只能绑定到同一工具服务中的工具。'); error.status = 409; throw error;
        }
        const isDefault = input.isDefault === true || input.is_default === true;
        const allowedScopes = Array.isArray(input.allowedScopes || input.allowed_scopes)
            ? (input.allowedScopes || input.allowed_scopes).map(item => String(item || '').trim()).filter(Boolean).slice(0, 100)
            : [];
        const fieldPolicy = input.fieldPolicy && typeof input.fieldPolicy === 'object' && !Array.isArray(input.fieldPolicy) ? input.fieldPolicy : {};
        await transact(async trx => {
            const db = databaseApi(trx);
            if (isDefault) await db.mutate("UPDATE tool_connection_bindings SET is_default = FALSE, updated_at = ? WHERE tool_item_id = ? AND status = 'active'", [now(), toolItemId]);
            await db.mutate(`
                INSERT INTO tool_connection_bindings (tool_item_id, connection_account_id, allowed_scopes, field_policy, is_default, status, created_at, updated_at)
                VALUES (?, ?, ?::jsonb, ?::jsonb, ?, 'active', ?, ?)
                ON CONFLICT(tool_item_id, connection_account_id) DO UPDATE SET
                    allowed_scopes = excluded.allowed_scopes, field_policy = excluded.field_policy,
                    is_default = excluded.is_default, status = 'active', updated_at = excluded.updated_at
            `, [toolItemId, connectionAccountId, JSON.stringify(allowedScopes), JSON.stringify(fieldPolicy), isDefault, now(), now()]);
        });
        return await readOne(`SELECT * FROM tool_connection_bindings WHERE tool_item_id = ? AND connection_account_id = ?`, [toolItemId, connectionAccountId]);
    }

    async function resolveBoundConnection(toolItemId, user) {
        const rows = await read(`
            SELECT b.connection_account_id, b.allowed_scopes, b.is_default, b.status
            FROM tool_connection_bindings b
            JOIN connection_accounts a ON a.id = b.connection_account_id
            WHERE b.tool_item_id = ? AND b.status = 'active'
            ORDER BY b.is_default DESC, b.updated_at DESC, b.id DESC
        `, [toolItemId]);
        for (const row of rows) {
            const account = await getForUser(row.connection_account_id, user);
            if (account) return { account, binding: { ...row, allowed_scopes: parseJson(row.allowed_scopes, []) } };
        }
        return null;
    }

    async function getConnectionAuthorization(id, user) {
        const account = await assertUsable(id, user);
        const row = await readOne('SELECT encrypted_secret_ref, connector_id FROM connection_accounts WHERE id = ?', [id]);
        if (!row?.encrypted_secret_ref) return null;
        let decoded = '';
        try { decoded = decryptSecret(row.encrypted_secret_ref, `connection_accounts:${id}:oauth_tokens`); }
        catch (_) { decoded = ''; }
        if (decoded) {
            const tokens = parseJson(decoded, {});
            if (tokens.accessToken) return { type: 'bearer', token: String(tokens.accessToken), accountId: account.id };
        }
        // Legacy API-key accounts deliberately never expose their secret through
        // this method: mcp-client reads mcp_servers.api_key in its own execution
        // boundary. Only OAuth access tokens require an override header.
        return null;
    }

    return { assertUsable, bindToolConnection, createAccount, ensureLegacyMcpAccount, getConnectionAuthorization, getForUser, listForUser, resolveBoundConnection, transition };
}

const defaultStore = createConnectionAccountStore();

module.exports = {
    canAccessConnectionAccount,
    publicConnectionAccount,
    ...defaultStore
};
