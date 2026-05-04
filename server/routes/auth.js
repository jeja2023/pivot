/* 认证路由模块 Authentication Routes */
const express = require('express');
const {
    register,
    login,
    refreshTokens,
    getCookie,
    AUTH_COOKIE_NAME,
    REFRESH_COOKIE_NAME,
    ACCESS_COOKIE_OPTIONS,
    REFRESH_COOKIE_OPTIONS
} = require('../auth');
const { asyncHandler } = require('../http');
const { stmts } = require('../db');

function createAuthRouter({
    authMiddleware,
    loginLimiter,
    isPublicRegistrationEnabled,
    logAction
}) {
    const router = express.Router();

    router.post('/auth/register', asyncHandler(async (req, res) => {
        if (!isPublicRegistrationEnabled()) {
            logAction(req, '注册拦截', `尝试注册账号: ${req.body?.username || '-'}`);
            return res.status(403).json({ error: '企业模式已关闭公开注册，请联系管理员创建账号' });
        }
        const { username, password, nickname, unit } = req.body;
        const user = register(username, password, nickname, unit);
        logAction(req, '用户注册', `注册账号: ${username}`);
        res.json(user);
    }));

    router.get('/auth/config', (req, res) => {
        res.json({ allowPublicRegistration: isPublicRegistrationEnabled() });
    });

    router.post('/auth/login', loginLimiter, asyncHandler(async (req, res) => {
        try {
            const data = login(req.body.username, req.body.password);
            req.user = data.user;
            logAction(req, '用户登录', '登录成功');
            
            // 设置两个 Cookie
            res.cookie(AUTH_COOKIE_NAME, data.accessToken, ACCESS_COOKIE_OPTIONS);
            res.cookie(REFRESH_COOKIE_NAME, data.refreshToken, REFRESH_COOKIE_OPTIONS);
            
            res.json({ 
                user: data.user,
                accessToken: data.accessToken // 也返回给前端，方便前端决定存储方式
            });
        } catch (e) {
            logAction(req, '登录失败', `账号: ${req.body?.username || '-'}，原因: ${e.message}`);
            res.status(401).json({ error: e.message });
        }
    }));

    router.post('/auth/refresh', asyncHandler(async (req, res) => {
        const refreshToken = getCookie(req, REFRESH_COOKIE_NAME);
        if (!refreshToken) {
            return res.status(401).json({ error: '缺失刷新令牌', code: 'REFRESH_TOKEN_MISSING' });
        }

        try {
            const data = refreshTokens(refreshToken);
            res.cookie(AUTH_COOKIE_NAME, data.accessToken, ACCESS_COOKIE_OPTIONS);
            res.cookie(REFRESH_COOKIE_NAME, data.refreshToken, REFRESH_COOKIE_OPTIONS);
            res.json({ accessToken: data.accessToken });
        } catch (e) {
            res.clearCookie(AUTH_COOKIE_NAME, ACCESS_COOKIE_OPTIONS);
            res.clearCookie(REFRESH_COOKIE_NAME, REFRESH_COOKIE_OPTIONS);
            res.status(401).json({ error: e.message, code: 'REFRESH_TOKEN_INVALID' });
        }
    }));

    router.get('/auth/me', authMiddleware, (req, res) => {
        res.json({ user: req.user });
    });

    router.post('/auth/logout', authMiddleware, (req, res) => {
        logAction(req, '用户退出', '退出登录');
        
        // 尝试从 Cookie 中获取并删除数据库中的 Refresh Token
        const refreshToken = getCookie(req, REFRESH_COOKIE_NAME);
        if (refreshToken) {
            stmts.deleteRefreshToken.run(refreshToken);
        }

        res.clearCookie(AUTH_COOKIE_NAME, { ...ACCESS_COOKIE_OPTIONS, maxAge: 0 });
        res.clearCookie(REFRESH_COOKIE_NAME, { ...REFRESH_COOKIE_OPTIONS, maxAge: 0 });
        res.json({ success: true });
    });

    return router;
}

module.exports = { createAuthRouter };
