const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { queryOne, execute, transaction } = require('./db/client');
const { getBeijingTimestamp } = require('./time');
const { weakSecrets } = require('./config');
const { parsePositiveInt } = require('./number');
const { normalizeRole, withPermissionFlags } = require('./permissions');
const { getApiAccessSetting } = require('./services/api-access-settings');
const { PASSWORD_RULE_DESCRIPTION, getPasswordValidationMessage } = require('./password-policy');

function apiKeyAllowsRequest(req, apiKeyData) {
    const path = String(req?.originalUrl || req?.url || '').split('?')[0];
    const scopes = String(apiKeyData?.scopes || 'openai').split(/[,\s]+/).map(item => item.trim()).filter(Boolean);
    return scopes.includes('openai') && /^\/v1(?:\/|$)/.test(path);
}

const { logger } = require('./logger');
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32 || weakSecrets.has(JWT_SECRET) || JWT_SECRET.includes('please-replace')) {
    logger.error('🚨 [安全警告] JWT_SECRET 未配置或强度不足，系统已拒绝启动。');
    process.exit(1);
}

const AUTH_COOKIE_NAME = 'pivot_access_token';
const REFRESH_COOKIE_NAME = 'pivot_refresh_token';
const DEVICE_COOKIE_NAME = 'pivot_device_id';
const CSRF_COOKIE_NAME = 'pivot_csrf_token';

const ACCESS_TOKEN_EXPIRES_MINUTES = parsePositiveInt(process.env.ACCESS_TOKEN_EXPIRES_MINUTES, 480);
const REFRESH_TOKEN_EXPIRES_DAYS = parsePositiveInt(process.env.REFRESH_TOKEN_EXPIRES_DAYS, 30);
const ACCESS_TOKEN_EXPIRES = `${ACCESS_TOKEN_EXPIRES_MINUTES}m`;
const BCRYPT_ROUNDS = Math.max(12, Math.min(Number.parseInt(process.env.BCRYPT_ROUNDS || '12', 10) || 12, 15));

const COOKIE_OPTIONS = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.COOKIE_SECURE === 'true'
};

const ACCESS_COOKIE_OPTIONS = {
    ...COOKIE_OPTIONS,
    maxAge: ACCESS_TOKEN_EXPIRES_MINUTES * 60 * 1000
};

const REFRESH_COOKIE_OPTIONS = {
    ...COOKIE_OPTIONS,
    path: '/api/auth',
    maxAge: REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000
};

const DEVICE_COOKIE_OPTIONS = {
    ...COOKIE_OPTIONS,
    path: '/api/auth',
    maxAge: 365 * 24 * 60 * 60 * 1000
};

const LEGACY_REFRESH_COOKIE_OPTIONS = {
    ...COOKIE_OPTIONS,
    path: '/api/auth/refresh',
    maxAge: REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000
};

const CLEAR_COOKIE_OPTIONS = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.COOKIE_SECURE === 'true'
};

const CLEAR_REFRESH_COOKIE_OPTIONS = {
    ...CLEAR_COOKIE_OPTIONS,
    path: '/api/auth'
};

const CLEAR_DEVICE_COOKIE_OPTIONS = {
    ...CLEAR_COOKIE_OPTIONS,
    path: '/api/auth'
};

const CLEAR_LEGACY_REFRESH_COOKIE_OPTIONS = {
    ...CLEAR_COOKIE_OPTIONS,
    path: '/api/auth/refresh'
};

const CLEAR_CSRF_COOKIE_OPTIONS = {
    sameSite: 'lax',
    path: '/',
    secure: process.env.COOKIE_SECURE === 'true'
};

class UserInputError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UserInputError';
        this.status = 400;
    }
}

function hashApiKey(key) {
    return crypto.createHash('sha256').update(String(key || '')).digest('hex');
}

function previewApiKey(key) {
    const text = String(key || '');
    return text ? `${text.slice(0, 3)}...${text.slice(-4)}` : '';
}

function generateCsrfToken() {
    return crypto.randomBytes(24).toString('base64url');
}

function generateAccessToken(user) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            nickname: user.nickname || '',
            unit: user.unit || '',
            role: normalizeRole(user.role),
            tv: Math.max(Number(user.token_version ?? user.tokenVersion ?? 0) || 0, 0)
        },
        JWT_SECRET,
        { expiresIn: ACCESS_TOKEN_EXPIRES }
    );
}

function hashRefreshToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function normalizeDeviceId(value) {
    const text = String(value || '').trim();
    return /^[A-Za-z0-9_-]{24,128}$/.test(text) ? text : '';
}

function generateDeviceId() {
    return crypto.randomBytes(24).toString('base64url');
}

async function generateRefreshToken(userId, deviceId = '') {
    return issueRefreshToken({ execute }, userId, crypto.randomUUID(), deviceId);
}

async function issueRefreshToken(executor, userId, familyId = crypto.randomUUID(), deviceId = '') {
    const token = crypto.randomBytes(40).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
    // 转换为北京时间字符串格式用于数据库存储 (YYYY-MM-DD HH:mm:ss)
    const expiresAtStr = getBeijingTimestamp(expiresAt);
    
    await executor.execute('INSERT INTO refresh_tokens (user_id, token, expires_at, family_id, device_id) VALUES (?, ?, ?, ?, ?)', [userId, hashRefreshToken(token), expiresAtStr, familyId, normalizeDeviceId(deviceId)]);
    return token;
}

async function rotateRefreshToken(tokenHash, userId) {
    return transaction(async trx => {
        const current = await trx.queryOne('SELECT family_id FROM refresh_tokens WHERE token = ? FOR UPDATE', [tokenHash]);
        if (!current) {
            throw new Error('刷新令牌已被使用或已失效，请重新登录。');
        }
        const changes = await trx.execute('DELETE FROM refresh_tokens WHERE token = ?', [tokenHash]);
        if (changes !== 1) {
            throw new Error('刷新令牌已被使用或已失效，请重新登录。');
        }
        return issueRefreshToken(trx, userId, current?.family_id || crypto.randomUUID());
    });
}

function validatePassword(password) {
    const message = getPasswordValidationMessage(password);
    if (message) throw new UserInputError(message);
}

function getCookie(req, name) {
    const cookieHeader = req.headers.cookie || '';
    const cookies = Object.fromEntries(cookieHeader.split(';').map(part => {
        const index = part.indexOf('=');
        if (index === -1) return ['', ''];
        try {
            return [
                decodeURIComponent(part.slice(0, index).trim()),
                decodeURIComponent(part.slice(index + 1).trim())
            ];
        } catch (e) {
            return ['', ''];
        }
    }).filter(([key]) => key));
    return cookies[name];
}

async function resolveAuthenticatedUserAsync(req) {
    const authHeader = req.headers?.authorization;
    const cookieToken = getCookie(req, AUTH_COOKIE_NAME);
    const token = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.split(' ')[1] : cookieToken;

    if (!token) {
        return { user: null, token: null, code: 'AUTH_MISSING' };
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await queryOne(
            'SELECT id, username, nickname, unit, role, status, created_at, default_model_id, token_version FROM users WHERE id = ? AND deleted_at IS NULL',
            [decoded.id]
        );
        if (user && user.status !== 'disabled' && Number(decoded.tv ?? 0) === Number(user.token_version || 0)) {
            return { user: withPermissionFlags(user), token, code: 'AUTH_OK' };
        }
    } catch (e) {
        if (e.name === 'TokenExpiredError' && !String(token).startsWith('sk-')) {
            return { user: null, token, code: 'TOKEN_EXPIRED' };
        }
    }

    if (String(token || '').startsWith('sk-') && !getApiAccessSetting()) {
        return { user: null, token, code: 'API_ACCESS_DISABLED' };
    }

    const apiKeyData = await queryOne(
        "SELECT * FROM api_keys WHERE key_hash = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)",
        [hashApiKey(token), getBeijingTimestamp()]
    );
    if (apiKeyData) {
        if (!apiKeyAllowsRequest(req, apiKeyData)) return { user: null, token, code: 'API_KEY_SCOPE_DENIED' };
        const user = await queryOne(
            'SELECT id, username, nickname, unit, role, status, created_at, default_model_id, token_version FROM users WHERE id = ? AND deleted_at IS NULL',
            [apiKeyData.user_id]
        );
        if (user && user.status !== 'disabled') {
            await execute('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [getBeijingTimestamp(), apiKeyData.id]);
            return { user: withPermissionFlags(user), token, apiKeyData, code: 'AUTH_OK' };
        }
    }

    return { user: null, token, code: 'TOKEN_INVALID' };
}

// 注册用户
async function register(username, password, nickname, unit, role = 'user') {
    const cleanUsername = String(username || '').trim();
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(cleanUsername)) {
        throw new UserInputError('用户名需为 3-32 位字母、数字、点、下划线或短横线');
    }
    validatePassword(password);
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const safeRole = normalizeRole(role);

    const deletedUser = await queryOne('SELECT id FROM users WHERE username = ? AND deleted_at IS NOT NULL', [cleanUsername]);
    if (deletedUser) {
        await execute('UPDATE users SET username = ? WHERE id = ?', [`deleted_${deletedUser.id}_${cleanUsername}`, deletedUser.id]);
    }
    try {
        await execute(
            'INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [cleanUsername, hash, nickname, unit, safeRole, 'active', getBeijingTimestamp()]
        );
        const created = await queryOne('SELECT id, username, nickname, role, status, created_at FROM users WHERE username = ? AND deleted_at IS NULL', [cleanUsername]);
        return withPermissionFlags(created);
    } catch (e) {
        if (e.code === '23505' || String(e.message).includes('duplicate key') || String(e.message).includes('unique constraint')) {
            throw new UserInputError('用户名已存在');
        }
        throw e;
    }
}

// 登录验证
async function login(username, password, options = {}) {
    const user = await queryOne('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL', [username]);
    if (!user || !await bcrypt.compare(password, user.password_hash)) {
        throw new Error('用户名或密码错误');
    }
    if (user.status === 'disabled') {
        throw new Error('账号已被禁用，请联系管理员');
    }
    // 旧账号在一次成功登录后以异步方式升级哈希成本，不阻塞登录响应。
    if ((bcrypt.getRounds(user.password_hash) || 0) < BCRYPT_ROUNDS) {
        bcrypt.hash(password, BCRYPT_ROUNDS)
            .then(hash => execute('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?', [hash, user.id, user.password_hash]))
            .catch(error => logger.warn({ err: error.message, userId: user.id }, '登录后密码哈希升级失败'));
    }
    const accessToken = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user.id, options.deviceId);
    await execute('UPDATE users SET last_login_at = ? WHERE id = ?', [getBeijingTimestamp(), user.id]);
    return { 
        accessToken, 
        refreshToken, 
        user: withPermissionFlags({ id: user.id, username: user.username, nickname: user.nickname, role: user.role, unit: user.unit, status: user.status || 'active', created_at: user.created_at })
    };
}

// 刷新 Token
async function refreshTokens(token, options = {}) {
    const tokenHash = hashRefreshToken(token);
    let terminalError = null;
    const result = await transaction(async trx => {
        // Lock, consume and issue the replacement token in one transaction.
        const refreshTokenData = await trx.queryOne('SELECT * FROM refresh_tokens WHERE token = ? FOR UPDATE', [tokenHash]);
        if (!refreshTokenData) {
            terminalError = new Error('无效的刷新令牌');
            return null;
        }
        const now = getBeijingTimestamp();
        if (refreshTokenData.expires_at < now) {
            await trx.execute('DELETE FROM refresh_tokens WHERE token = ?', [tokenHash]);
            terminalError = new Error('刷新令牌已过期，请重新登录');
            return null;
        }
        if (refreshTokenData.consumed_at) {
            await trx.execute('DELETE FROM refresh_tokens WHERE user_id = ? AND family_id = ?', [refreshTokenData.user_id, refreshTokenData.family_id || '']);
            await trx.execute('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?', [refreshTokenData.user_id]);
            terminalError = new Error('检测到刷新令牌重放，当前登录会话已全部撤销，请重新登录。');
            return null;
        }
        const requestedDeviceId = normalizeDeviceId(options.deviceId);
        const boundDeviceId = normalizeDeviceId(refreshTokenData.device_id);
        if (boundDeviceId && boundDeviceId !== requestedDeviceId) {
            await trx.execute('DELETE FROM refresh_tokens WHERE user_id = ? AND family_id = ?', [refreshTokenData.user_id, refreshTokenData.family_id || '']);
            await trx.execute('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?', [refreshTokenData.user_id]);
            terminalError = new Error('刷新令牌设备绑定不匹配，当前登录会话已全部撤销，请重新登录。');
            return null;
        }
        const user = await trx.queryOne('SELECT * FROM users WHERE id = ?', [refreshTokenData.user_id]);
        if (!user || user.status === 'disabled') {
            terminalError = new Error('用户状态异常');
            return null;
        }
        const changes = await trx.execute('UPDATE refresh_tokens SET consumed_at = ? WHERE token = ? AND consumed_at IS NULL', [now, tokenHash]);
        if (changes !== 1) {
            terminalError = new Error('刷新令牌已被使用或已失效，请重新登录。');
            return null;
        }
        const accessToken = generateAccessToken(user);
        const newRefreshToken = await issueRefreshToken(trx, user.id, refreshTokenData.family_id || crypto.randomUUID(), requestedDeviceId || boundDeviceId);
        return { accessToken, refreshToken: newRefreshToken };
    });
    if (terminalError) throw terminalError;
    return result;
}

// 鉴权中间件
async function authMiddleware(req, res, next) {
    try {
        const auth = await resolveAuthenticatedUserAsync(req);

        if (!auth.token) {
            return res.status(401).json({ error: '未授权访问', code: 'AUTH_MISSING' });
        }

        if (auth.code === 'TOKEN_EXPIRED') {
            return res.status(401).json({ error: 'Token 已过期', code: 'TOKEN_EXPIRED' });
        }

        if (auth.code === 'API_ACCESS_DISABLED') {
            return res.status(403).json({ error: 'API 接入已由管理员关闭' });
        }

        if (auth.code === 'API_KEY_SCOPE_DENIED') {
            return res.status(403).json({ error: 'API Key 仅允许访问 OpenAI 兼容接口', code: 'API_KEY_SCOPE_DENIED' });
        }

        if (auth.user) {
            req.user = auth.user;
            if (req.raw) req.raw.user = auth.user;
            if (auth.apiKeyData) {
                req.isApiKey = true;
                req.apiKeyId = auth.apiKeyData.id;
            }
            return next();
        }

        return res.status(401).json({ error: 'Token 无效或已过期', code: 'TOKEN_INVALID' });
    } catch (err) {
        logger.error({ err: err.message }, '认证中间件处理失败');
        return res.status(500).json({ error: '认证服务异常', code: 'AUTH_ERROR' });
    }
}

function csrfMiddleware(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) return next();
    if (['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout'].includes(req.path)) return next();
    const cookieToken = getCookie(req, CSRF_COOKIE_NAME);
    const headerToken = req.headers['x-csrf-token'];
    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
        return res.status(403).json({ error: 'CSRF 校验失败', code: 'CSRF_INVALID' });
    }
    next();
}

module.exports = { 
    register, 
    login, 
    refreshTokens,
    authMiddleware, 
    validatePassword, 
    getCookie,
    resolveAuthenticatedUserAsync,
    AUTH_COOKIE_NAME,
    REFRESH_COOKIE_NAME,
    DEVICE_COOKIE_NAME,
    CSRF_COOKIE_NAME,
    ACCESS_COOKIE_OPTIONS, 
    REFRESH_COOKIE_OPTIONS,
    DEVICE_COOKIE_OPTIONS,
    LEGACY_REFRESH_COOKIE_OPTIONS,
    CLEAR_COOKIE_OPTIONS,
    CLEAR_REFRESH_COOKIE_OPTIONS,
    CLEAR_DEVICE_COOKIE_OPTIONS,
    CLEAR_LEGACY_REFRESH_COOKIE_OPTIONS,
    CLEAR_CSRF_COOKIE_OPTIONS,
    generateCsrfToken,
    generateDeviceId,
    csrfMiddleware,
    hashApiKey,
    previewApiKey,
    UserInputError,
    PASSWORD_RULE_DESCRIPTION,
    getPasswordValidationMessage,
    hashRefreshToken,
    rotateRefreshToken,
    generateRefreshToken,
    generateAccessToken
};
