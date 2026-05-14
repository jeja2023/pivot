const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db, stmts } = require('./db');
const { getBeijingTimestamp } = require('./time');
const { weakSecrets } = require('./config');

const { logger } = require('./logger');
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32 || weakSecrets.has(JWT_SECRET) || JWT_SECRET.includes('please-replace')) {
    logger.error('🚨 [安全警告] JWT_SECRET 未配置或强度不足，系统已拒绝启动。');
    process.exit(1);
}

const AUTH_COOKIE_NAME = 'pivot_access_token';
const REFRESH_COOKIE_NAME = 'pivot_refresh_token';
const CSRF_COOKIE_NAME = 'pivot_csrf_token';

const parsePositiveInt = (value, fallback) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

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
    path: '/api/auth/refresh', // 仅刷新接口可见，提高安全性
    maxAge: REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000
};

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
        { id: user.id, username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: ACCESS_TOKEN_EXPIRES }
    );
}

function generateRefreshToken(userId) {
    const token = crypto.randomBytes(40).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
    // 转换为北京时间字符串格式用于数据库存储 (YYYY-MM-DD HH:mm:ss)
    const expiresAtStr = getBeijingTimestamp(expiresAt);
    
    stmts.insertRefreshToken.run(userId, token, expiresAtStr);
    return token;
}

function validatePassword(password) {
    if (!password || password.length < 8) {
        throw new Error('密码长度至少需要 8 位');
    }
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
        throw new Error('密码必须同时包含字母和数字');
    }
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
    const authHeader = req.headers.authorization;
    const cookieToken = getCookie(req, AUTH_COOKIE_NAME);
    const token = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.split(' ')[1] : cookieToken;

    if (!token) {
        return { user: null, token: null, code: 'AUTH_MISSING' };
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = stmts.getUserById.get(decoded.id);
        if (user && user.status !== 'disabled') {
            return { user, token, code: 'AUTH_OK' };
        }
    } catch (e) {
        if (e.name === 'TokenExpiredError' && !String(token).startsWith('sk-')) {
            return { user: null, token, code: 'TOKEN_EXPIRED' };
        }
    }

    const apiKeyData = db.prepare("SELECT * FROM api_keys WHERE key_hash = ? AND status = 'active'").get(hashApiKey(token));
    if (apiKeyData) {
        const user = stmts.getUserById.get(apiKeyData.user_id);
        if (user && user.status !== 'disabled') {
            db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(getBeijingTimestamp(), apiKeyData.id);
            return { user, token, apiKeyData, code: 'AUTH_OK' };
        }
    }

    return { user: null, token, code: 'TOKEN_INVALID' };
}

// 注册用户
function register(username, password, nickname, unit, role = 'user') {
    const cleanUsername = String(username || '').trim();
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(cleanUsername)) {
        throw new Error('用户名需为 3-32 位字母、数字、点、下划线或短横线');
    }
    validatePassword(password);
    const hash = bcrypt.hashSync(password, 10);
    const safeRole = role === 'admin' ? 'admin' : 'user';
    const stmt = db.prepare('INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    try {
        const info = stmt.run(cleanUsername, hash, nickname, unit, safeRole, 'active', getBeijingTimestamp());
        return { id: info.lastInsertRowid, username: cleanUsername, nickname, role: safeRole, status: 'active' };
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            throw new Error('用户名已存在');
        }
        throw e;
    }
}

// 登录验证
function login(username, password) {
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        throw new Error('用户名或密码错误');
    }
    if (user.status === 'disabled') {
        throw new Error('账号已被禁用，请联系管理员');
    }
    
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user.id);
    
    // 更新最后登录时间
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(getBeijingTimestamp(), user.id);
    
    return { 
        accessToken, 
        refreshToken, 
        user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role, unit: user.unit, status: user.status || 'active' } 
    };
}

// 刷新 Token
function refreshTokens(token) {
    const refreshTokenData = stmts.getRefreshToken.get(token);
    if (!refreshTokenData) {
        throw new Error('无效的刷新令牌');
    }

    // 检查是否过期
    const now = getBeijingTimestamp();
    if (refreshTokenData.expires_at < now) {
        stmts.deleteRefreshToken.run(token);
        throw new Error('刷新令牌已过期，请重新登录');
    }

    const user = stmts.getUserById.get(refreshTokenData.user_id);
    if (!user || user.status === 'disabled') {
        throw new Error('用户状态异常');
    }

    // 生成新的 Access Token
    const accessToken = generateAccessToken(user);
    
    // 实施 Refresh Token 轮换（可选，为了更安全，生成一个新的并删除旧的）
    const newRefreshToken = generateRefreshToken(user.id);
    stmts.deleteRefreshToken.run(token);

    return { accessToken, refreshToken: newRefreshToken };
}

// 鉴权中间件
function authMiddleware(req, res, next) {
    const auth = resolveAuthenticatedUser(req);

    if (!auth.token) {
        return res.status(401).json({ error: '未授权访问' });
    }

    if (auth.code === 'TOKEN_EXPIRED') {
        return res.status(401).json({ error: 'Token 已过期', code: 'TOKEN_EXPIRED' });
    }

    if (auth.user) {
        req.user = auth.user;
        if (auth.apiKeyData) {
            req.isApiKey = true;
            req.apiKeyId = auth.apiKeyData.id;
        }
        return next();
    }

    return res.status(401).json({ error: 'Token 无效或已过期', code: 'TOKEN_INVALID' });
}

function csrfMiddleware(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) return next();
    if (['/auth/login', '/auth/register', '/auth/refresh'].includes(req.path)) return next();
    const cookieToken = getCookie(req, CSRF_COOKIE_NAME);
    const headerToken = req.headers['x-csrf-token'];
    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
        return res.status(403).json({ error: 'CSRF 校验失败' });
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
    AUTH_COOKIE_NAME, 
    REFRESH_COOKIE_NAME,
    CSRF_COOKIE_NAME,
    ACCESS_COOKIE_OPTIONS,
    REFRESH_COOKIE_OPTIONS,
    generateCsrfToken,
    csrfMiddleware,
    hashApiKey,
    previewApiKey
};
