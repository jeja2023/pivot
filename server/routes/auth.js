/* 认证路由模块 Authentication Routes */
const express = require('express');
const {
    register,
    login,
    AUTH_COOKIE_NAME,
    COOKIE_OPTIONS
} = require('../auth');

function createAuthRouter({
    authMiddleware,
    loginLimiter,
    isPublicRegistrationEnabled,
    logAction
}) {
    const router = express.Router();

    router.post('/auth/register', (req, res) => {
        if (!isPublicRegistrationEnabled()) {
            logAction(req, '注册拦截', `尝试注册账号: ${req.body?.username || '-'}`);
            return res.status(403).json({ error: '企业模式已关闭公开注册，请联系管理员创建账号' });
        }
        try {
            const { username, password, nickname, unit } = req.body;
            const user = register(username, password, nickname, unit);
            logAction(req, '用户注册', `注册账号: ${username}`);
            res.json(user);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.get('/auth/config', (req, res) => {
        res.json({ allowPublicRegistration: isPublicRegistrationEnabled() });
    });

    router.post('/auth/login', loginLimiter, (req, res) => {
        try {
            const data = login(req.body.username, req.body.password);
            req.user = data.user;
            logAction(req, '用户登录', '登录成功');
            res.cookie(AUTH_COOKIE_NAME, data.token, COOKIE_OPTIONS);
            res.json(data);
        } catch (e) {
            logAction(req, '登录失败', `账号: ${req.body?.username || '-'}，原因: ${e.message}`);
            res.status(401).json({ error: e.message });
        }
    });

    router.get('/auth/me', authMiddleware, (req, res) => {
        res.json({ user: req.user });
    });

    router.post('/auth/logout', authMiddleware, (req, res) => {
        logAction(req, '用户退出', '退出登录');
        res.clearCookie(AUTH_COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: undefined });
        res.json({ success: true });
    });

    return router;
}

module.exports = { createAuthRouter };
