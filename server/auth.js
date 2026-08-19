const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { queryOne, execute } = require('./db/client');
const { getBeijingTimestamp } = require('./time');
const { weakSecrets } = require('./config');
const { parsePositiveInt } = require('./number');
const { normalizeRole, withPermissionFlags } = require('./permissions');
const { getApiAccessSetting } = require('./services/api-access-settings');

const { logger } = require('./logger');
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32 || weakSecrets.has(JWT_SECRET) || JWT_SECRET.includes('please-replace')) {
    logger.error('🚨 [安全警告] JWT_SECRET 未配置或强度不足，系统已拒绝启动。');
    process.exit(1);
}

const AUTH_COOKIE_NAME = 'pivot_access_token';
const REFRESH_COOKIE_NAME = 'pivot_refresh_token';
const CSRF_COOKIE_NAME = 'pivot_csrf_token';

const ACCESS_TOKEN_EXPIRES_MINUTES = parsePositiveInt(process.env.ACCESS_TOKEN_EXPIRES_MINUTES, 480);
const REFRESH_TOKEN_EXPIRES_DAYS = parsePositiveInt(process.env.REFRESH_TOKEN_EXPIRES_DAYS, 30);
const ACCESS_TOKEN_EXPIRES = `${ACCESS_TOKEN_EXPIRES_MINUTES}m`;

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

const PASSWORD_RULE_DESCRIPTION = '至少 8 位，并同时包含字母和数字';

function getPasswordValidationMessage(password) {
    if (!password) {
        return `请输入密码。密码要求：${PASSWORD_RULE_DESCRIPTION}。`;
    }
    const missing = [];
    if (String(password).length < 8) missing.push('至少 8 位');
    if (!/[A-Za-z]/.test(password)) missing.push('包含字母');
    if (!/[0-9]/.test(password)) missing.push('包含数字');
    if (missing.length === 0) return '';
    return `密码不符合要求：请确保${missing.join('、')}。完整规则：${PASSWORD_RULE_DESCRIPTION}。`;
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
            role: normalizeRole(user.role)
        },
        JWT_SECRET,
        { expiresIn: ACCESS_TOKEN_EXPIRES }
    );
}

function hashRefreshToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

async function generateRefreshToken(userId) {
    const token = crypto.randomBytes(40).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
    // 转换为北京时间字符串格式用于数据库存储 (YYYY-MM-DD HH:mm:ss)
    const expiresAtStr = getBeijingTimestamp(expiresAt);
    
    await execute('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)', [userId, hashRefreshToken(token), expiresAtStr]);
    return token;
}

async function rotateRefreshToken(tokenHash, userId) {
    const changes = await execute('DELETE FROM refresh_tokens WHERE token = ?', [tokenHash]);
    if (changes !== 1) {
        throw new Error('刷新令牌已被使用或已失效，请重新登录。');
    }
    return await generateRefreshToken(userId);
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

function resolveAuthenticatedUser(req) {
    const authHeader = req.headers?.authorization;
    const cookieToken = getCookie(req, AUTH_COOKIE_NAME);
    const token = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.split(' ')[1] : cookieToken;

    if (!token) {
        return { user: null, token: null, code: 'AUTH_MISSING' };
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded && decoded.id) {
            return {
                user: withPermissionFlags({
                    id: decoded.id,
                    username: decoded.username,
                    nickname: decoded.nickname || '',
                    unit: decoded.unit || '',
                    role: decoded.role || 'user',
                    status: 'active'
                }),
                token,
                code: 'AUTH_OK'
            };
        }
    } catch (e) {
        if (e.name === 'TokenExpiredError' && !String(token).startsWith('sk-')) {
            return { user: null, token, code: 'TOKEN_EXPIRED' };
        }
    }

    if (String(token || '').startsWith('sk-') && !getApiAccessSetting()) {
        return { user: null, token, code: 'API_ACCESS_DISABLED' };
    }

    return { user: null, token, code: 'TOKEN_INVALID' };
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
            'SELECT id, username, nickname, unit, role, status, default_model_id FROM users WHERE id = ? AND deleted_at IS NULL',
            [decoded.id]
        );
        if (user && user.status !== 'disabled') {
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
        "SELECT * FROM api_keys WHERE key_hash = ? AND status = 'active'",
        [hashApiKey(token)]
    );
    if (apiKeyData) {
        const user = await queryOne(
            'SELECT id, username, nickname, unit, role, status, default_model_id FROM users WHERE id = ? AND deleted_at IS NULL',
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
    const hash = bcrypt.hashSync(password, 10);
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
        const created = await queryOne('SELECT id, username, nickname, role, status FROM users WHERE username = ? AND deleted_at IS NULL', [cleanUsername]);
        return withPermissionFlags(created);
    } catch (e) {
        if (e.code === '23505' || String(e.message).includes('duplicate key') || String(e.message).includes('unique constraint')) {
            throw new UserInputError('用户名已存在');
        }
        throw e;
    }
}

// 登录验证
async function login(username, password) {
    const user = await queryOne('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        throw new Error('用户名或密码错误');
    }
    if (user.status === 'disabled') {
        throw new Error('账号已被禁用，请联系管理员');
    }
    const accessToken = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user.id);
    await execute('UPDATE users SET last_login_at = ? WHERE id = ?', [getBeijingTimestamp(), user.id]);
    return { 
        accessToken, 
        refreshToken, 
        user: withPermissionFlags({ id: user.id, username: user.username, nickname: user.nickname, role: user.role, unit: user.unit, status: user.status || 'active' })
    };
}

// 刷新 Token
async function refreshTokens(token) {
    const tokenHash = hashRefreshToken(token);
    const refreshTokenData = await queryOne('SELECT * FROM refresh_tokens WHERE token = ?', [tokenHash]);
    if (!refreshTokenData) {
        throw new Error('无效的刷新令牌');
    }
    const now = getBeijingTimestamp();
    if (refreshTokenData.expires_at < now) {
        await execute('DELETE FROM refresh_tokens WHERE token = ?', [tokenHash]);
        throw new Error('刷新令牌已过期，请重新登录');
    }
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [refreshTokenData.user_id]);
    if (!user || user.status === 'disabled') {
        throw new Error('用户状态异常');
    }
    const accessToken = generateAccessToken(user);
    await execute('DELETE FROM refresh_tokens WHERE token = ?', [tokenHash]);
    const newRefreshToken = await generateRefreshToken(user.id);
    return { accessToken, refreshToken: newRefreshToken };
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
    if (['/auth/login', '/auth/register', '/auth/refresh'].includes(req.path)) return next();
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
    resolveAuthenticatedUser,
    resolveAuthenticatedUserAsync,
    AUTH_COOKIE_NAME, 
    REFRESH_COOKIE_NAME,
    CSRF_COOKIE_NAME,
    ACCESS_COOKIE_OPTIONS, 
    REFRESH_COOKIE_OPTIONS,
    LEGACY_REFRESH_COOKIE_OPTIONS,
    CLEAR_COOKIE_OPTIONS,
    CLEAR_REFRESH_COOKIE_OPTIONS,
    CLEAR_LEGACY_REFRESH_COOKIE_OPTIONS,
    CLEAR_CSRF_COOKIE_OPTIONS,
    generateCsrfToken,
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
