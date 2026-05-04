/* 认证中间件与逻辑 */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { getBeijingTimestamp } = require('./time');
const { weakSecrets } = require('./config');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32 || weakSecrets.has(JWT_SECRET) || JWT_SECRET.includes('please-replace')) {
    console.error('\\n🚨 [安全警告] JWT_SECRET 未配置或强度不足，系统已拒绝启动。\\n');
    process.exit(1);
}

const AUTH_COOKIE_NAME = 'pivot_token';
const COOKIE_OPTIONS = {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 7 * 24 * 60 * 60 * 1000
};

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
        return [
            decodeURIComponent(part.slice(0, index).trim()),
            decodeURIComponent(part.slice(index + 1).trim())
        ];
    }).filter(([key]) => key));
    return cookies[name];
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
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        throw new Error('用户名或密码错误');
    }
    if (user.status === 'disabled') {
        throw new Error('账号已被禁用，请联系管理员');
    }
    
    const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
    
    return { token, user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role, unit: user.unit, status: user.status || 'active' } };
}

// 鉴权中间件
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    const cookieToken = getCookie(req, AUTH_COOKIE_NAME);
    const token = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.split(' ')[1] : cookieToken;
    
    if (!token) {
        return res.status(401).json({ error: '未授权访问' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = db.prepare('SELECT id, username, nickname, unit, role, status FROM users WHERE id = ?').get(decoded.id);
        if (!user || user.status === 'disabled') {
            return res.status(401).json({ error: '账号不存在或已被禁用' });
        }
        req.user = user;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Token 无效或已过期' });
    }
}

module.exports = { register, login, authMiddleware, validatePassword, AUTH_COOKIE_NAME, COOKIE_OPTIONS };
