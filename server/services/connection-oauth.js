'use strict';

/**
 * OAuth 2.0 Authorization Code + PKCE lifecycle for connection accounts.
 * Provider tokens are encrypted at rest and never leave this module in public
 * account projections, tool schemas, model context, traces, or invocation logs.
 */
const crypto = require('crypto');
const { queryOne, execute: mutate } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { encryptSecret, decryptSecret, assertSafeMcpOutboundUrl } = require('../security');
const { safeJsonRequest } = require('./safe-http-client');
const { canAccessConnectionAccount, publicConnectionAccount } = require('./connection-accounts');
const { isSuperAdmin } = require('../permissions');

const OAUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_OAUTH_RESPONSE_BYTES = 512 * 1024;

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value || '') || fallback; } catch (_) { return fallback; }
}

function randomUrlToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
}

function hash(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function pkceChallenge(verifier) {
    return crypto.createHash('sha256').update(String(verifier || '')).digest('base64url');
}

function oauthError(message, code = 'CONNECTION_OAUTH_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.expose = true;
    return error;
}

function isAllowedOAuthUrl(raw, { allowHttp = false } = {}) {
    try {
        const value = new URL(String(raw || '').trim());
        return value.protocol === 'https:' || (allowHttp && value.protocol === 'http:');
    } catch (_) {
        return false;
    }
}

function oauthConfig(definition = {}) {
    const config = parseJson(definition.config, {});
    const authorizationUrl = String(config.authorizationUrl || config.authorization_url || '').trim();
    const tokenUrl = String(config.tokenUrl || config.token_url || '').trim();
    const clientId = String(config.clientId || config.client_id || '').trim();
    const revocationUrl = String(config.revocationUrl || config.revocation_url || '').trim();
    const redirectUris = Array.isArray(config.redirectUris || config.redirect_uris)
        ? (config.redirectUris || config.redirect_uris).map(item => String(item || '').trim()).filter(Boolean).slice(0, 20)
        : [];
    const defaultScopes = Array.isArray(definition.default_scopes)
        ? definition.default_scopes
        : parseJson(definition.default_scopes, []);
    return {
        authorizationUrl,
        tokenUrl,
        revocationUrl,
        clientId,
        clientSecretEncrypted: String(config.clientSecretEncrypted || config.client_secret_encrypted || ''),
        redirectUris,
        defaultScopes: Array.isArray(defaultScopes) ? defaultScopes.map(item => String(item || '').trim()).filter(Boolean).slice(0, 100) : [],
        authorizationParams: config.authorizationParams && typeof config.authorizationParams === 'object' && !Array.isArray(config.authorizationParams)
            ? Object.fromEntries(Object.entries(config.authorizationParams).slice(0, 20).map(([key, value]) => [String(key).slice(0, 80), String(value).slice(0, 1000)]))
            : {}
    };
}

function publicConnectorDefinition(row = {}) {
    const config = parseJson(row.config, {});
    const safeConfig = { ...config };
    delete safeConfig.clientSecretEncrypted;
    delete safeConfig.client_secret_encrypted;
    return {
        id: row.id,
        slug: row.slug,
        display_name: row.display_name,
        icon: row.icon || '',
        category: row.category || 'general',
        docs_url: row.docs_url || '',
        auth_type: row.auth_type || 'none',
        supported_protocols: Array.isArray(row.supported_protocols) ? row.supported_protocols : parseJson(row.supported_protocols, []),
        default_scopes: Array.isArray(row.default_scopes) ? row.default_scopes : parseJson(row.default_scopes, []),
        data_residency: row.data_residency || 'unknown',
        privacy_url: row.privacy_url || '',
        owner: row.owner || '',
        version: row.version || '1.0.0',
        status: row.status || 'active',
        config: safeConfig
    };
}

function selectRedirectUri(config, input = {}) {
    const requested = String(input.redirectUri || input.redirect_uri || '').trim();
    const fallback = String(process.env.PIVOT_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    const defaultUri = fallback ? `${fallback}/api/connection-accounts/oauth/callback` : '';
    const allowed = config.redirectUris.length ? config.redirectUris : (defaultUri ? [defaultUri] : []);
    const uri = requested || allowed[0] || '';
    const allowHttp = String(process.env.PIVOT_ALLOW_INSECURE_OAUTH_HTTP || '').toLowerCase() === 'true';
    if (!uri || !allowed.includes(uri) || !isAllowedOAuthUrl(uri, { allowHttp })) {
        throw oauthError('OAuth 回调地址未在连接器允许列表中，或地址格式不安全。', 'CONNECTION_OAUTH_REDIRECT_INVALID');
    }
    return uri;
}

function formEncode(values = {}) {
    const params = new URLSearchParams();
    Object.entries(values).forEach(([key, value]) => {
        if (value !== undefined && value !== null && String(value) !== '') params.set(key, String(value));
    });
    return params.toString();
}

function normalizeScopes(value, fallback = []) {
    const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : fallback;
    return [...new Set(raw.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 100);
}

function expiryFromSeconds(value) {
    const seconds = Math.min(Math.max(Number.parseInt(value, 10) || 0, 0), 365 * 24 * 60 * 60);
    return seconds ? getBeijingTimestamp(new Date(Date.now() + seconds * 1000)) : null;
}

function createConnectionOAuthService(deps = {}) {
    const readOne = deps.queryOne || queryOne;
    const write = deps.execute || mutate;
    const now = deps.getBeijingTimestamp || getBeijingTimestamp;
    const request = deps.safeJsonRequest || safeJsonRequest;
    const assertUrl = deps.assertSafeMcpOutboundUrl || assertSafeMcpOutboundUrl;
    const encrypt = deps.encryptSecret || encryptSecret;
    const decrypt = deps.decryptSecret || decryptSecret;

    async function saveConnectorDefinition(user, input = {}) {
        if (!isSuperAdmin(user)) throw oauthError('只有系统管理员可以维护连接器定义。', 'CONNECTOR_DEFINITION_FORBIDDEN', 403);
        const id = Number(input.id || 0) || null;
        const slug = String(input.slug || '').trim().toLowerCase();
        const displayName = String(input.displayName ?? input.display_name ?? '').trim().slice(0, 255);
        const authType = String(input.authType ?? input.auth_type ?? 'none').trim();
        if (!/^[a-z0-9][a-z0-9.-]{1,126}$/.test(slug) || !displayName || !['none', 'api_key', 'oauth2', 'service_account', 'database'].includes(authType)) {
            throw oauthError('连接器定义缺少有效的 slug、展示名称或鉴权类型。', 'CONNECTOR_DEFINITION_INVALID');
        }
        const existing = id ? await readOne('SELECT * FROM connector_definitions WHERE id = ?', [id]) : null;
        if (id && !existing) throw oauthError('连接器定义不存在。', 'CONNECTOR_DEFINITION_NOT_FOUND', 404);
        const configInput = input.config && typeof input.config === 'object' && !Array.isArray(input.config) ? input.config : {};
        const clientSecret = input.clientSecret ?? input.client_secret;
        const config = {
            authorizationUrl: String(configInput.authorizationUrl || configInput.authorization_url || '').trim(),
            tokenUrl: String(configInput.tokenUrl || configInput.token_url || '').trim(),
            revocationUrl: String(configInput.revocationUrl || configInput.revocation_url || '').trim(),
            clientId: String(configInput.clientId || configInput.client_id || '').trim(),
            redirectUris: Array.isArray(configInput.redirectUris || configInput.redirect_uris) ? (configInput.redirectUris || configInput.redirect_uris).map(item => String(item || '').trim()).filter(Boolean).slice(0, 20) : [],
            authorizationParams: configInput.authorizationParams && typeof configInput.authorizationParams === 'object' && !Array.isArray(configInput.authorizationParams) ? configInput.authorizationParams : {}
        };
        if (authType === 'oauth2') {
            const allowHttp = String(process.env.PIVOT_ALLOW_INSECURE_OAUTH_HTTP || '').toLowerCase() === 'true';
            if (!isAllowedOAuthUrl(config.authorizationUrl, { allowHttp }) || !isAllowedOAuthUrl(config.tokenUrl, { allowHttp }) || !config.clientId || !config.redirectUris.length || config.redirectUris.some(uri => !isAllowedOAuthUrl(uri, { allowHttp }))) {
                throw oauthError('OAuth 连接器必须配置安全的授权地址、令牌地址、客户端标识和回调白名单。', 'CONNECTOR_OAUTH_CONFIG_INVALID');
            }
        }
        config.clientSecretEncrypted = clientSecret === undefined || clientSecret === '********'
            ? String(parseJson(existing?.config, {}).clientSecretEncrypted || '')
            : encrypt(String(clientSecret || ''), `connector_definitions:${slug}:client_secret`);
        const protocols = Array.isArray(input.supportedProtocols || input.supported_protocols) ? (input.supportedProtocols || input.supported_protocols).map(item => String(item || '').trim()).filter(Boolean).slice(0, 20) : ['mcp'];
        const scopes = normalizeScopes(input.defaultScopes || input.default_scopes, []);
        const nowValue = now();
        const row = await readOne(`
            INSERT INTO connector_definitions (
                slug, display_name, icon, category, docs_url, auth_type, supported_protocols, default_scopes,
                data_residency, privacy_url, owner, version, status, config, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
            ON CONFLICT(slug) DO UPDATE SET display_name = excluded.display_name, icon = excluded.icon,
                category = excluded.category, docs_url = excluded.docs_url, auth_type = excluded.auth_type,
                supported_protocols = excluded.supported_protocols, default_scopes = excluded.default_scopes,
                data_residency = excluded.data_residency, privacy_url = excluded.privacy_url, owner = excluded.owner,
                version = excluded.version, status = excluded.status, config = excluded.config, updated_at = excluded.updated_at
            RETURNING *
        `, [
            slug, displayName, String(input.icon || '').slice(0, 4000), String(input.category || 'general').slice(0, 64), String(input.docsUrl || input.docs_url || '').slice(0, 4000), authType,
            JSON.stringify(protocols), JSON.stringify(scopes), String(input.dataResidency || input.data_residency || 'unknown').slice(0, 64), String(input.privacyUrl || input.privacy_url || '').slice(0, 4000),
            String(input.owner || '').slice(0, 255), String(input.version || '1.0.0').slice(0, 64), input.status === 'disabled' ? 'disabled' : 'active', JSON.stringify(config), nowValue, nowValue
        ]);
        return publicConnectorDefinition(row);
    }

    async function accountWithDefinition(accountId, user, executor = { queryOne: readOne }) {
        const one = (...args) => executor.queryOne(...args);
        const row = await one(`
            SELECT a.*, d.slug AS connector_slug, d.auth_type AS connector_auth_type, d.config AS connector_config,
                   d.default_scopes AS connector_default_scopes, d.status AS connector_status
            FROM connection_accounts a JOIN connector_definitions d ON d.id = a.connector_id
            WHERE a.id = ?
        `, [accountId]);
        if (!row || !canAccessConnectionAccount(row, user)) return null;
        return row;
    }

    function assertOauthEnabled(row) {
        if (row?.connector_auth_type !== 'oauth2' || row?.connector_status !== 'active') {
            throw oauthError('该连接器未启用 OAuth 授权。', 'CONNECTION_OAUTH_NOT_SUPPORTED', 409);
        }
        const config = oauthConfig({ config: row.connector_config, default_scopes: row.connector_default_scopes });
        const allowHttp = String(process.env.PIVOT_ALLOW_INSECURE_OAUTH_HTTP || '').toLowerCase() === 'true';
        if (!isAllowedOAuthUrl(config.authorizationUrl, { allowHttp }) || !isAllowedOAuthUrl(config.tokenUrl, { allowHttp }) || !config.clientId) {
            throw oauthError('该 OAuth 连接器缺少安全的授权地址、令牌地址或客户端标识。', 'CONNECTION_OAUTH_CONFIG_INVALID', 409);
        }
        return config;
    }

    async function startAuthorization(accountId, user, input = {}) {
        const account = await accountWithDefinition(accountId, user);
        if (!account) throw oauthError('连接账户不存在或无权访问。', 'CONNECTION_ACCOUNT_NOT_FOUND', 404);
        const config = assertOauthEnabled(account);
        await assertUrl(config.authorizationUrl, user);
        const redirectUri = selectRedirectUri(config, input);
        const state = randomUrlToken(32);
        const verifier = randomUrlToken(48);
        const requestId = `oauth_${randomUrlToken(24)}`;
        const expiresAt = getBeijingTimestamp(new Date(Date.now() + OAUTH_REQUEST_TTL_MS));
        const scopes = normalizeScopes(input.scopes, config.defaultScopes);
        await write(`
            INSERT INTO connection_authorization_requests (
                id, connection_account_id, user_id, state_hash, code_verifier_encrypted, redirect_uri,
                expires_at, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `, [requestId, account.id, user.id, hash(state), encrypt(verifier, `connection_authorization_requests:${requestId}:verifier`), redirectUri, expiresAt, now(), now()]);
        await write("UPDATE connection_accounts SET auth_state = 'authorizing', last_error = '', updated_at = ? WHERE id = ?", [now(), account.id]);
        const url = new URL(config.authorizationUrl);
        Object.entries(config.authorizationParams).forEach(([key, value]) => url.searchParams.set(key, value));
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', config.clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('state', state);
        url.searchParams.set('code_challenge', pkceChallenge(verifier));
        url.searchParams.set('code_challenge_method', 'S256');
        if (scopes.length) url.searchParams.set('scope', scopes.join(' '));
        return { authorizationUrl: url.toString(), expiresAt, accountId: account.id, requestId };
    }

    async function exchangeCode({ account, config, code, verifier, redirectUri, user }) {
        await assertUrl(config.tokenUrl, user);
        const clientSecret = config.clientSecretEncrypted ? decrypt(config.clientSecretEncrypted, `connector_definitions:${account.connector_slug}:client_secret`) : '';
        const response = await request({
            method: 'post', url: config.tokenUrl,
            data: formEncode({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: config.clientId, client_secret: clientSecret, code_verifier: verifier }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            user, assertUrl: (url, actor) => assertUrl(url, actor), timeout: 30_000,
            maxContentLength: MAX_OAUTH_RESPONSE_BYTES, maxBodyLength: 32 * 1024
        });
        const data = response?.data && typeof response.data === 'object' ? response.data : {};
        if (!String(data.access_token || '').trim()) throw oauthError('OAuth 服务未返回访问令牌。', 'CONNECTION_OAUTH_TOKEN_INVALID', 502);
        return data;
    }

    async function storeTokens(account, tokens, { user, requestId = '' } = {}) {
        const scopes = normalizeScopes(tokens.scope, parseJson(account.scopes, []));
        const secret = {
            accessToken: String(tokens.access_token || ''), refreshToken: String(tokens.refresh_token || ''),
            tokenType: String(tokens.token_type || 'Bearer'), issuedAt: now()
        };
        const encrypted = encrypt(JSON.stringify(secret), `connection_accounts:${account.id}:oauth_tokens`);
        const expiresAt = expiryFromSeconds(tokens.expires_in);
        await write(`
            UPDATE connection_accounts
            SET encrypted_secret_ref = ?, auth_state = 'active', scopes = ?::jsonb, expires_at = ?,
                last_refresh_at = ?, last_error = '', revoked_at = NULL, updated_at = ?
            WHERE id = ?
        `, [encrypted, JSON.stringify(scopes), expiresAt, now(), now(), account.id]);
        if (requestId) await write("UPDATE connection_authorization_requests SET status = 'completed', consumed_at = ?, updated_at = ? WHERE id = ?", [now(), now(), requestId]);
        return await accountWithDefinition(account.id, user);
    }

    async function completeAuthorization({ state, code, error: providerError = '', errorDescription = '', user }) {
        const stateText = String(state || '').trim();
        if (!stateText) throw oauthError('OAuth 回调缺少 state。', 'CONNECTION_OAUTH_STATE_REQUIRED');
        const requestRow = await readOne(`
            SELECT r.id AS authorization_request_id, r.connection_account_id AS authorization_connection_account_id,
                   r.user_id AS authorization_user_id, r.state_hash, r.code_verifier_encrypted, r.redirect_uri,
                   r.expires_at AS authorization_expires_at, r.status AS authorization_status, r.consumed_at AS authorization_consumed_at,
                   a.id AS account_id, a.connector_id, a.server_id, a.tenant_id, a.owner_user_id, a.ownership_scope,
                   a.display_name, a.auth_state, a.provider_subject, a.encrypted_secret_ref, a.scopes, a.expires_at,
                   a.last_refresh_at, a.last_error, a.revoked_at, a.metadata, a.created_at, a.updated_at,
                   d.slug AS connector_slug, d.auth_type AS connector_auth_type, d.config AS connector_config, d.default_scopes AS connector_default_scopes, d.status AS connector_status
            FROM connection_authorization_requests r
            JOIN connection_accounts a ON a.id = r.connection_account_id
            JOIN connector_definitions d ON d.id = a.connector_id
            WHERE r.state_hash = ?
        `, [hash(stateText)]);
        if (!requestRow || Number(requestRow.authorization_user_id) !== Number(user?.id)) throw oauthError('OAuth 授权请求不存在或不属于当前用户。', 'CONNECTION_OAUTH_STATE_INVALID', 403);
        if (requestRow.authorization_status !== 'pending' || requestRow.authorization_consumed_at || Date.parse(requestRow.authorization_expires_at) <= Date.now()) {
            throw oauthError('OAuth 授权请求已失效或已被使用。', 'CONNECTION_OAUTH_STATE_EXPIRED', 409);
        }
        const account = { ...requestRow, id: requestRow.account_id };
        const config = assertOauthEnabled(account);
        if (providerError) {
            await write("UPDATE connection_authorization_requests SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?", [String(errorDescription || providerError).slice(0, 2000), now(), now(), requestRow.authorization_request_id]);
            await write("UPDATE connection_accounts SET auth_state = 'refresh_failed', last_error = ?, updated_at = ? WHERE id = ?", [String(errorDescription || providerError).slice(0, 2000), now(), requestRow.authorization_connection_account_id]);
            throw oauthError(`OAuth 授权被服务商拒绝：${String(errorDescription || providerError).slice(0, 500)}`, 'CONNECTION_OAUTH_PROVIDER_DENIED', 403);
        }
        if (!String(code || '').trim()) throw oauthError('OAuth 回调缺少授权码。', 'CONNECTION_OAUTH_CODE_REQUIRED');
        const claimed = await mutate("UPDATE connection_authorization_requests SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'", [now(), requestRow.authorization_request_id]);
        if (claimed !== 1) throw oauthError('OAuth 授权请求正在处理或已失效。', 'CONNECTION_OAUTH_STATE_CONFLICT', 409);
        try {
            const verifier = decrypt(requestRow.code_verifier_encrypted, `connection_authorization_requests:${requestRow.authorization_request_id}:verifier`);
            const tokens = await exchangeCode({ account, config, code: String(code).trim(), verifier, redirectUri: requestRow.redirect_uri, user });
            return publicConnectionAccount(await storeTokens(account, tokens, { user, requestId: requestRow.authorization_request_id }));
        } catch (exchangeError) {
            await write("UPDATE connection_authorization_requests SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?", [String(exchangeError.message || '').slice(0, 2000), now(), now(), requestRow.authorization_request_id]);
            await write("UPDATE connection_accounts SET auth_state = 'refresh_failed', last_error = ?, updated_at = ? WHERE id = ?", [String(exchangeError.message || '').slice(0, 2000), now(), requestRow.authorization_connection_account_id]);
            throw exchangeError;
        }
    }

    async function refreshAccount(accountId, user) {
        const account = await accountWithDefinition(accountId, user);
        if (!account) throw oauthError('连接账户不存在或无权访问。', 'CONNECTION_ACCOUNT_NOT_FOUND', 404);
        const config = assertOauthEnabled(account);
        let stored;
        try { stored = parseJson(decrypt(account.encrypted_secret_ref, `connection_accounts:${account.id}:oauth_tokens`), {}); }
        catch (_) { stored = {}; }
        if (!String(stored.refreshToken || '').trim()) throw oauthError('该连接账户没有可用刷新令牌，请重新授权。', 'CONNECTION_OAUTH_REAUTH_REQUIRED', 409);
        try {
            await assertUrl(config.tokenUrl, user);
            const clientSecret = config.clientSecretEncrypted ? decrypt(config.clientSecretEncrypted, `connector_definitions:${account.connector_slug}:client_secret`) : '';
            const response = await request({
                method: 'post', url: config.tokenUrl,
                data: formEncode({ grant_type: 'refresh_token', refresh_token: stored.refreshToken, client_id: config.clientId, client_secret: clientSecret }),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, user,
                assertUrl: (url, actor) => assertUrl(url, actor), timeout: 30_000, maxContentLength: MAX_OAUTH_RESPONSE_BYTES, maxBodyLength: 32 * 1024
            });
            const tokens = response?.data && typeof response.data === 'object' ? { ...response.data, refresh_token: response.data.refresh_token || stored.refreshToken } : {};
            if (!tokens.access_token) throw oauthError('OAuth 刷新未返回访问令牌。', 'CONNECTION_OAUTH_TOKEN_INVALID', 502);
            return publicConnectionAccount(await storeTokens(account, tokens, { user }));
        } catch (error) {
            await write("UPDATE connection_accounts SET auth_state = 'refresh_failed', last_error = ?, updated_at = ? WHERE id = ?", [String(error.message || '').slice(0, 2000), now(), account.id]);
            throw error;
        }
    }

    async function revokeAccount(accountId, user) {
        const account = await accountWithDefinition(accountId, user);
        if (!account) throw oauthError('连接账户不存在或无权访问。', 'CONNECTION_ACCOUNT_NOT_FOUND', 404);
        let providerRevoked = false;
        if (account.connector_auth_type === 'oauth2') {
            const config = oauthConfig({ config: account.connector_config, default_scopes: account.connector_default_scopes });
            let stored;
            try { stored = parseJson(decrypt(account.encrypted_secret_ref, `connection_accounts:${account.id}:oauth_tokens`), {}); } catch (_) { stored = {}; }
            if (config.revocationUrl && stored.accessToken) {
                try {
                    await assertUrl(config.revocationUrl, user);
                    const response = await request({ method: 'post', url: config.revocationUrl, data: formEncode({ token: stored.refreshToken || stored.accessToken, client_id: config.clientId }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, user, assertUrl: (url, actor) => assertUrl(url, actor), timeout: 20_000, maxContentLength: MAX_OAUTH_RESPONSE_BYTES, maxBodyLength: 16 * 1024, validateStatus: status => status >= 200 && status < 500 });
                    providerRevoked = response.status >= 200 && response.status < 300;
                } catch (_) {}
            }
        }
        await write("UPDATE connection_accounts SET encrypted_secret_ref = '', auth_state = 'revoked', scopes = '[]'::jsonb, expires_at = NULL, revoked_at = ?, last_error = '', updated_at = ? WHERE id = ?", [now(), now(), account.id]);
        return { account: publicConnectionAccount(await accountWithDefinition(account.id, user)), providerRevoked };
    }

    return { completeAuthorization, publicConnectorDefinition, refreshAccount, revokeAccount, saveConnectorDefinition, startAuthorization };
}

const defaultService = createConnectionOAuthService();

module.exports = {
    formEncode,
    isAllowedOAuthUrl,
    oauthConfig,
    pkceChallenge,
    publicConnectorDefinition,
    selectRedirectUri,
    ...defaultService
};
